// Chart-overlay geometry for the breakout engine.
//
// The detector (`src/lib/alpha/breakout.ts`) returns a verdict for the LAST bar
// only, which is all the trading engine needs but useless for visual review:
// you cannot see where the range was, which edge broke, or how long the AI
// intended to hold. This module replays the detector bar-by-bar and turns the
// result into drawable series:
//
//   - `points[]`   — per-bar close plus the rolling Donchian channel, split
//                    into `bandBase` / `bandSpan` so a stacked area renders the
//                    range as a shaded box without a custom shape.
//   - `signals[]`  — one entry per breakout episode/cohort, carrying the level
//                    that broke, the ATR stop/target and BOTH exits: the
//                    planned time exit (entry + horizon) and the exit the tape
//                    actually produced.
//
// Pure and IO-free: same inputs ⇒ same overlay, so it can be unit tested and
// reused by the backtest card, the holding drill-down and any future replay UI.

import {
  DEFAULT_BREAKOUT_CONFIG,
  detectBreakout,
  type BreakoutCandle,
  type BreakoutConfig,
} from "@/lib/alpha/breakout";
import {
  atrAt,
  simulateTrade,
  type BacktestBar,
  type SignalCohort,
  type SignalTrade,
} from "@/lib/breakout-backtest";

export type BreakoutOverlayConfig = {
  /** Bars to accumulate before the detector is trusted. */
  warmupBars: number;
  /** Max bars a signal is expected to be held (the planned time exit). */
  horizonBars: number;
  /** Stop distance in ATRs. 0 disables. */
  stopAtr: number;
  /** Target distance in ATRs. 0 disables. */
  targetAtr: number;
  /** Round-trip cost charged to the simulated outcome, in bps. */
  costBps: number;
  /** Bars before the same cohort may repeat across episodes. */
  cooldownBars: number;
  /** Detector overrides — defaults mirror the live engine. */
  detector: Partial<BreakoutConfig>;
};

export const DEFAULT_BREAKOUT_OVERLAY_CONFIG: BreakoutOverlayConfig = {
  warmupBars: 80,
  horizonBars: 10,
  stopAtr: 2,
  targetAtr: 3,
  costBps: 20,
  cooldownBars: 5,
  detector: {},
};

export type OverlayPoint = {
  date: string;
  close: number;
  high: number;
  low: number;
  /** Donchian extremes of the lookback ENDING on the previous bar. */
  channelHigh: number | null;
  channelLow: number | null;
  /** Stacked-area helpers: base = channelLow, span = width of the range. */
  bandBase: number | null;
  bandSpan: number | null;
};

export type OverlaySignal = {
  /** Index into `points`. */
  index: number;
  date: string;
  cohort: SignalCohort;
  direction: "up" | "down";
  side: "long" | "short";
  /** The Donchian extreme that was pierced — the breakout/breakdown level. */
  level: number;
  channelHigh: number | null;
  channelLow: number | null;
  quality: number;
  penetrationAtr: number;
  volumeRatio: number | null;
  falseBreakoutRate: number;
  atr: number;
  entry: number;
  stop: number | null;
  target: number | null;
  /** Planned time exit: entry + horizonBars. Null date when beyond the data. */
  plannedExitIndex: number;
  plannedExitDate: string | null;
  /** What the tape actually did within the horizon. */
  exitIndex: number;
  exitDate: string | null;
  exitPrice: number;
  exitReason: SignalTrade["exitReason"];
  barsHeld: number;
  returnPct: number;
};

export type BreakoutOverlay = {
  symbol: string;
  points: OverlayPoint[];
  signals: OverlaySignal[];
  /** Most recent signal, the one a reviewer usually wants pre-selected. */
  latest: OverlaySignal | null;
  config: BreakoutOverlayConfig;
};

function cleanBars(bars: readonly BacktestBar[]): BacktestBar[] {
  return bars
    .filter(
      (b) =>
        Number.isFinite(b.close) &&
        Number.isFinite(b.high) &&
        Number.isFinite(b.low) &&
        b.close > 0,
    )
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Rolling Donchian extremes for bar `i`, measured over the `channelBars` bars
 * BEFORE it. Excluding the current bar is what makes a pierce meaningful: a
 * channel that includes today can never be broken by today.
 */
function channelAt(
  bars: readonly BacktestBar[],
  i: number,
  channelBars: number,
): { high: number; low: number } | null {
  const start = i - channelBars;
  if (start < 0 || i < 1) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let k = start; k < i; k++) {
    const b = bars[k]!;
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return { high: hi, low: lo };
}

export function buildBreakoutOverlay(
  symbol: string,
  bars: readonly BacktestBar[],
  config: Partial<BreakoutOverlayConfig> = {},
): BreakoutOverlay {
  const cfg: BreakoutOverlayConfig = { ...DEFAULT_BREAKOUT_OVERLAY_CONFIG, ...config };
  const detector: BreakoutConfig = { ...DEFAULT_BREAKOUT_CONFIG, ...cfg.detector };
  const clean = cleanBars(bars);

  const points: OverlayPoint[] = clean.map((b, i) => {
    const ch = channelAt(clean, i, detector.channelBars);
    return {
      date: b.date,
      close: b.close,
      high: b.high,
      low: b.low,
      channelHigh: ch ? ch.high : null,
      channelLow: ch ? ch.low : null,
      bandBase: ch ? ch.low : null,
      bandSpan: ch ? Math.max(0, ch.high - ch.low) : null,
    };
  });

  const signals: OverlaySignal[] = [];
  if (clean.length > cfg.warmupBars + 1) {
    const candles: BreakoutCandle[] = clean.map((b) => ({
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume ?? undefined,
    }));

    // Episode bookkeeping mirrors `runBreakoutBacktest` exactly so the overlay
    // marks the same signals the scorecard counted — a chart that disagreed
    // with the backtest would be worse than no chart.
    const episodeSeen = new Set<SignalCohort>();
    const lastEmit = new Map<SignalCohort, number>();

    for (let i = cfg.warmupBars; i < clean.length; i++) {
      const ev = detectBreakout(candles.slice(0, i + 1), detector);
      if (ev.state === "none" || !ev.direction || ev.level == null) {
        episodeSeen.clear();
        continue;
      }
      const cohort = ev.state as SignalCohort;
      if (episodeSeen.has(cohort)) continue;
      if (i - (lastEmit.get(cohort) ?? -Infinity) < cfg.cooldownBars) continue;

      const atr = atrAt(clean, i);
      if (!atr) continue;

      // A failed breakout is a reversal signal: it trades AGAINST the pierce.
      const side: "long" | "short" =
        cohort === "failed"
          ? ev.direction === "up"
            ? "short"
            : "long"
          : ev.direction === "up"
            ? "long"
            : "short";

      const sim = simulateTrade(clean, i, side, atr, cfg);
      const entry = clean[i]!.close;
      const dir = side === "long" ? 1 : -1;
      const plannedExitIndex = i + cfg.horizonBars;
      const exitIndex = i + Math.max(sim.barsHeld, 0);

      signals.push({
        index: i,
        date: clean[i]!.date,
        cohort,
        direction: ev.direction,
        side,
        level: ev.level,
        channelHigh: ev.channel_high,
        channelLow: ev.channel_low,
        quality: ev.quality,
        penetrationAtr: ev.penetration_atr,
        volumeRatio: ev.volume_ratio,
        falseBreakoutRate: ev.false_breakout_rate,
        atr,
        entry,
        stop: cfg.stopAtr > 0 ? entry - dir * cfg.stopAtr * atr : null,
        target: cfg.targetAtr > 0 ? entry + dir * cfg.targetAtr * atr : null,
        plannedExitIndex,
        plannedExitDate: clean[plannedExitIndex]?.date ?? null,
        exitIndex,
        exitDate: clean[exitIndex]?.date ?? null,
        exitPrice: sim.exit,
        exitReason: sim.exitReason,
        barsHeld: sim.barsHeld,
        returnPct: sim.returnPct,
      });

      episodeSeen.add(cohort);
      lastEmit.set(cohort, i);
      if (cohort === "failed") episodeSeen.clear();
    }
  }

  return {
    symbol,
    points,
    signals,
    latest: signals.length ? signals[signals.length - 1]! : null,
    config: cfg,
  };
}

/** Trim the overlay to the last `n` bars, keeping only signals still visible. */
export function windowOverlay(overlay: BreakoutOverlay, n: number): BreakoutOverlay {
  if (n <= 0 || overlay.points.length <= n) return overlay;
  const offset = overlay.points.length - n;
  const points = overlay.points.slice(offset);
  const signals = overlay.signals
    .filter((s) => s.index >= offset)
    .map((s) => ({
      ...s,
      index: s.index - offset,
      plannedExitIndex: s.plannedExitIndex - offset,
      exitIndex: s.exitIndex - offset,
    }));
  return {
    ...overlay,
    points,
    signals,
    latest: signals.length ? signals[signals.length - 1]! : null,
  };
}

/** Y-domain that always contains the band, the stops and the targets. */
export function overlayDomain(
  overlay: BreakoutOverlay,
  signal: OverlaySignal | null,
  padPct = 0.04,
): [number, number] {
  const vals: number[] = [];
  for (const p of overlay.points) {
    vals.push(p.high, p.low);
    if (p.channelHigh != null) vals.push(p.channelHigh);
    if (p.channelLow != null) vals.push(p.channelLow);
  }
  if (signal) {
    vals.push(signal.level, signal.entry);
    if (signal.stop != null) vals.push(signal.stop);
    if (signal.target != null) vals.push(signal.target);
  }
  const finite = vals.filter((v) => Number.isFinite(v));
  if (!finite.length) return [0, 1];
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const pad = Math.max((hi - lo) * padPct, Math.abs(hi) * 0.001, 1e-6);
  return [lo - pad, hi + pad];
}
