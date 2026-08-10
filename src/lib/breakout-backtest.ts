// Breakout signal backtest — did the breakout engine's evidence actually pay?
//
// The detector in `src/lib/alpha/breakout.ts` labels every bar as none /
// pending / confirmed / extended / failed. This module replays that detector
// bar-by-bar over historical candles, opens a hypothetical trade at each *new*
// signal, and measures what happened next. The point is falsifiability: if
// "confirmed" breakouts do not out-perform "failed" ones, the sizing
// multipliers wired into the engine are unearned.
//
// Trade convention (mirrors how the alpha model is consumed):
//   confirmed / pending / extended  → trade WITH the direction (up = long)
//   failed                          → trade AGAINST it (a failed upside
//                                     breakout is a bearish reversal tell)
//
// Every trade is opened at the signal bar's close, then held for at most
// `horizonBars`, exiting early on an ATR stop or an ATR target. Returns are
// signed for the trade direction (a short that falls 3% returns +3%) and are
// charged `costBps` round-trip so the win rates are net, not gross.
//
// Pure module: candles in, report out. No I/O, no clock, no randomness.

import {
  DEFAULT_BREAKOUT_CONFIG,
  detectBreakout,
  type BreakoutCandle,
  type BreakoutConfig,
  type BreakoutState,
} from "@/lib/alpha/breakout";
import {
  benchmarkIndex,
  classifyRegimeBars,
  type RegimeLabel,
  type RegimeThresholds,
} from "@/lib/regime-walk-forward";

export type BacktestBar = {
  date: string;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
};

export type SymbolBars = { symbol: string; bars: BacktestBar[] };

/** Cohorts we report on. "none" is not a signal, so it never appears. */
export type SignalCohort = Exclude<BreakoutState, "none">;
export const SIGNAL_COHORTS: readonly SignalCohort[] = [
  "confirmed",
  "pending",
  "extended",
  "failed",
] as const;

export type BreakoutBacktestConfig = {
  /** Max bars a hypothetical trade is held before a time exit. */
  horizonBars: number;
  /** Stop distance in ATRs (adverse). 0 disables the stop. */
  stopAtr: number;
  /** Profit target in ATRs. 0 disables the target. */
  targetAtr: number;
  /** Round-trip cost charged to every trade, in basis points. */
  costBps: number;
  /** Bars to wait before the same symbol can emit another signal. */
  cooldownBars: number;
  /** Bars of history required before the detector is trusted. */
  warmupBars: number;
  /** Only score signals whose evidence quality clears this (failed = exempt). */
  minQuality: number;
  /** Detector overrides — defaults mirror the live engine. */
  detector: Partial<BreakoutConfig>;
  /** Regime classifier overrides. */
  regime: Partial<RegimeThresholds>;
};

export const DEFAULT_BREAKOUT_BACKTEST_CONFIG: BreakoutBacktestConfig = {
  horizonBars: 10,
  stopAtr: 2,
  targetAtr: 3,
  costBps: 20,
  cooldownBars: 5,
  warmupBars: 80,
  minQuality: 0,
  detector: {},
  regime: {},
};

export type SignalTrade = {
  symbol: string;
  date: string;
  cohort: SignalCohort;
  /** Breakout direction on the tape (up = broke the high). */
  direction: "up" | "down";
  /** Direction of the hypothetical trade taken. */
  side: "long" | "short";
  regime: RegimeLabel;
  quality: number;
  penetrationAtr: number;
  volumeRatio: number | null;
  falseBreakoutRate: number;
  entry: number;
  exit: number;
  exitReason: "target" | "stop" | "horizon" | "data_end";
  barsHeld: number;
  /** Net return in %, signed for the trade side, after `costBps`. */
  returnPct: number;
  /** Worst mark-to-market against the trade while open, in % (<= 0). */
  maxAdversePct: number;
  /** Best mark-to-market in favour of the trade, in % (>= 0). */
  maxFavourablePct: number;
};

export type CohortStats = {
  cohort: SignalCohort | "all";
  regime: RegimeLabel | "all";
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgReturnPct: number;
  medianReturnPct: number;
  avgWinPct: number;
  avgLossPct: number;
  /** avgWin*winRate + avgLoss*lossRate — the per-trade edge. */
  expectancyPct: number;
  profitFactor: number | null;
  bestPct: number;
  worstPct: number;
  /** Max drawdown of the cohort's compounded, chronologically ordered trades. */
  maxDrawdownPct: number;
  /** Compounded return if every signal in the cohort were traded at 1 unit. */
  cumulativeReturnPct: number;
  avgMaxAdversePct: number;
  avgBarsHeld: number;
};

export type BreakoutBacktestReport = {
  config: BreakoutBacktestConfig;
  symbols: string[];
  /** Inclusive date range actually covered by scored signals. */
  from: string | null;
  to: string | null;
  barsScanned: number;
  trades: SignalTrade[];
  /** Cohort × regime grid, plus regime="all" rows and a cohort="all" row. */
  stats: CohortStats[];
  regimeDays: Record<RegimeLabel, number>;
  /** Headline comparison the report exists to answer. */
  edge: {
    confirmedWinRatePct: number;
    failedWinRatePct: number;
    /** confirmed − failed, in percentage points. */
    winRateGapPp: number;
    confirmedAvgReturnPct: number;
    failedAvgReturnPct: number;
    avgReturnGapPct: number;
    verdict: "supported" | "weak" | "not_supported" | "insufficient_data";
    notes: string[];
  };
};

const EPS = 1e-9;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Wilder-free simple ATR over the trailing `period` bars ending at `idx`. */
export function atrAt(bars: readonly BacktestBar[], idx: number, period = 14): number | null {
  if (idx < period) return null;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const c = bars[i]!;
    const prev = bars[i - 1]!;
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  }
  const atr = sum / period;
  return atr > EPS ? atr : null;
}

/**
 * Walk a trade forward from `entryIdx` and resolve its exit.
 * Intrabar ordering is pessimistic: when both the stop and the target are
 * touched in the same bar we assume the stop filled first.
 */
export function simulateTrade(
  bars: readonly BacktestBar[],
  entryIdx: number,
  side: "long" | "short",
  atr: number,
  cfg: Pick<BreakoutBacktestConfig, "horizonBars" | "stopAtr" | "targetAtr" | "costBps">,
): Pick<SignalTrade, "exit" | "exitReason" | "barsHeld" | "returnPct" | "maxAdversePct" | "maxFavourablePct"> {
  const entry = bars[entryIdx]!.close;
  const dir = side === "long" ? 1 : -1;
  const stop = cfg.stopAtr > 0 ? entry - dir * cfg.stopAtr * atr : null;
  const target = cfg.targetAtr > 0 ? entry + dir * cfg.targetAtr * atr : null;

  let exit = entry;
  let exitReason: SignalTrade["exitReason"] = "data_end";
  let barsHeld = 0;
  let maxAdverse = 0;
  let maxFavourable = 0;

  for (let k = 1; k <= cfg.horizonBars; k++) {
    const i = entryIdx + k;
    const bar = bars[i];
    if (!bar) {
      exitReason = barsHeld > 0 ? "data_end" : "data_end";
      break;
    }
    barsHeld = k;
    const adverse = side === "long" ? bar.low : bar.high;
    const favourable = side === "long" ? bar.high : bar.low;
    maxAdverse = Math.min(maxAdverse, ((adverse - entry) / entry) * 100 * dir);
    maxFavourable = Math.max(maxFavourable, ((favourable - entry) / entry) * 100 * dir);

    const stopHit = stop != null && (side === "long" ? bar.low <= stop : bar.high >= stop);
    const targetHit = target != null && (side === "long" ? bar.high >= target : bar.low <= target);
    if (stopHit) {
      exit = stop!;
      exitReason = "stop";
      break;
    }
    if (targetHit) {
      exit = target!;
      exitReason = "target";
      break;
    }
    exit = bar.close;
    exitReason = k === cfg.horizonBars ? "horizon" : "data_end";
  }

  const gross = entry > EPS ? ((exit - entry) / entry) * 100 * dir : 0;
  const returnPct = gross - cfg.costBps / 100;
  return { exit, exitReason, barsHeld, returnPct, maxAdversePct: maxAdverse, maxFavourablePct: maxFavourable };
}

function statsFor(
  cohort: CohortStats["cohort"],
  regime: CohortStats["regime"],
  trades: readonly SignalTrade[],
): CohortStats {
  const rets = trades.map((t) => t.returnPct);
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  // Chronological compounding for a cohort-level drawdown.
  const ordered = [...trades].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const t of ordered) {
    equity *= 1 + t.returnPct / 100;
    if (equity > peak) peak = equity;
    if (peak > EPS) maxDd = Math.min(maxDd, (equity - peak) / peak);
  }

  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const avgWin = mean(wins);
  const avgLoss = mean(losses);
  return {
    cohort,
    regime,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: winRate,
    avgReturnPct: mean(rets),
    medianReturnPct: median(rets),
    avgWinPct: avgWin,
    avgLossPct: avgLoss,
    expectancyPct: (winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss,
    profitFactor: grossLoss > EPS ? grossWin / grossLoss : grossWin > EPS ? null : 0,
    bestPct: rets.length ? Math.max(...rets) : 0,
    worstPct: rets.length ? Math.min(...rets) : 0,
    maxDrawdownPct: maxDd * 100,
    cumulativeReturnPct: (equity - 1) * 100,
    avgMaxAdversePct: mean(trades.map((t) => t.maxAdversePct)),
    avgBarsHeld: mean(trades.map((t) => t.barsHeld)),
  };
}

/** Regime label per date, derived from an equal-weight index of the inputs. */
export function regimeTimeline(
  series: readonly SymbolBars[],
  thresholds: Partial<RegimeThresholds> = {},
): Map<string, RegimeLabel> {
  const byDate = new Map<string, Record<string, number>>();
  for (const s of series) {
    for (const b of s.bars) {
      if (!Number.isFinite(b.close) || b.close <= 0) continue;
      const row = byDate.get(b.date) ?? {};
      row[s.symbol] = b.close;
      byDate.set(b.date, row);
    }
  }
  const dates = [...byDate.keys()].sort();
  const index = benchmarkIndex(dates.map((date) => ({ date, closes: byDate.get(date)! })));
  const out = new Map<string, RegimeLabel>();
  if (!index.length) return out;
  for (const bar of classifyRegimeBars(index, thresholds)) out.set(bar.date, bar.label);
  return out;
}

/**
 * Replay the breakout detector across every symbol and score what each
 * signal would have earned.
 */
export function runBreakoutBacktest(
  series: readonly SymbolBars[],
  config: Partial<BreakoutBacktestConfig> = {},
): BreakoutBacktestReport {
  const cfg: BreakoutBacktestConfig = { ...DEFAULT_BREAKOUT_BACKTEST_CONFIG, ...config };
  const detector: BreakoutConfig = { ...DEFAULT_BREAKOUT_CONFIG, ...cfg.detector };
  const regimeByDate = regimeTimeline(series, cfg.regime);

  const trades: SignalTrade[] = [];
  let barsScanned = 0;

  for (const { symbol, bars } of series) {
    const clean = bars
      .filter(
        (b) =>
          Number.isFinite(b.close) &&
          Number.isFinite(b.high) &&
          Number.isFinite(b.low) &&
          b.close > 0,
      )
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (clean.length < cfg.warmupBars + cfg.horizonBars + 1) continue;

    const candles: BreakoutCandle[] = clean.map((b) => ({
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume ?? undefined,
    }));

    // One observation per cohort per breakout *episode*: a pending signal must
    // not swallow the confirmation that follows it two bars later, but neither
    // should a five-bar confirmation run count five times. `cooldownBars`
    // additionally spaces repeats of the same cohort across episodes.
    const episodeSeen = new Set<SignalCohort>();
    const lastEmit = new Map<SignalCohort, number>();
    for (let i = cfg.warmupBars; i < clean.length - 1; i++) {
      barsScanned++;
      const ev = detectBreakout(candles.slice(0, i + 1), detector);
      if (ev.state === "none" || !ev.direction) {
        episodeSeen.clear();
        continue;
      }
      const cohort = ev.state as SignalCohort;
      if (episodeSeen.has(cohort)) continue;
      if (i - (lastEmit.get(cohort) ?? -Infinity) < cfg.cooldownBars) continue;
      if (cohort !== "failed" && ev.quality < cfg.minQuality) continue;

      const atr = atrAt(clean, i);
      if (!atr) continue;

      const side: "long" | "short" =
        cohort === "failed"
          ? ev.direction === "up"
            ? "short"
            : "long"
          : ev.direction === "up"
            ? "long"
            : "short";

      const sim = simulateTrade(clean, i, side, atr, cfg);
      if (sim.barsHeld === 0) continue;

      trades.push({
        symbol,
        date: clean[i]!.date,
        cohort,
        direction: ev.direction,
        side,
        regime: regimeByDate.get(clean[i]!.date) ?? "sideways",
        quality: ev.quality,
        penetrationAtr: ev.penetration_atr,
        volumeRatio: ev.volume_ratio,
        falseBreakoutRate: ev.false_breakout_rate,
        entry: clean[i]!.close,
        ...sim,
      });
      episodeSeen.add(cohort);
      lastEmit.set(cohort, i);
      // A failure closes the episode — anything after it is a fresh attempt.
      if (cohort === "failed") episodeSeen.clear();
    }
  }


  trades.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const regimes: RegimeLabel[] = ["bull", "bear", "sideways"];
  const stats: CohortStats[] = [];
  for (const cohort of SIGNAL_COHORTS) {
    const inCohort = trades.filter((t) => t.cohort === cohort);
    stats.push(statsFor(cohort, "all", inCohort));
    for (const r of regimes) stats.push(statsFor(cohort, r, inCohort.filter((t) => t.regime === r)));
  }
  stats.push(statsFor("all", "all", trades));
  for (const r of regimes) stats.push(statsFor("all", r, trades.filter((t) => t.regime === r)));

  const regimeDays: Record<RegimeLabel, number> = { bull: 0, bear: 0, sideways: 0 };
  for (const label of regimeByDate.values()) regimeDays[label]++;

  const confirmed = stats.find((s) => s.cohort === "confirmed" && s.regime === "all")!;
  const failed = stats.find((s) => s.cohort === "failed" && s.regime === "all")!;
  const notes: string[] = [];
  const minSample = 20;
  let verdict: BreakoutBacktestReport["edge"]["verdict"];
  if (confirmed.trades < minSample || failed.trades < minSample) {
    verdict = "insufficient_data";
    notes.push(
      `Only ${confirmed.trades} confirmed and ${failed.trades} failed signals — need ${minSample}+ of each before the gap means anything.`,
    );
  } else {
    const gap = confirmed.winRatePct - failed.winRatePct;
    const retGap = confirmed.avgReturnPct - failed.avgReturnPct;
    if (gap >= 5 && retGap > 0 && confirmed.expectancyPct > 0) {
      verdict = "supported";
      notes.push(
        `Confirmed breakouts win ${gap.toFixed(1)}pp more often and earn ${retGap.toFixed(2)}pp more per trade than failed ones.`,
      );
    } else if (gap > 0 || retGap > 0) {
      verdict = "weak";
      notes.push(
        `Confirmed edges out failed (${gap.toFixed(1)}pp win rate, ${retGap.toFixed(2)}pp return) but not by enough to lean on.`,
      );
    } else {
      verdict = "not_supported";
      notes.push(
        `Confirmed signals did not beat failed ones (${gap.toFixed(1)}pp win rate, ${retGap.toFixed(2)}pp return) — the size multiplier is unearned on this sample.`,
      );
    }
  }
  if (confirmed.maxDrawdownPct < -25) {
    notes.push(`Confirmed cohort drew down ${confirmed.maxDrawdownPct.toFixed(1)}% at 1 unit per signal.`);
  }
  const bestRegime = regimes
    .map((r) => stats.find((s) => s.cohort === "confirmed" && s.regime === r)!)
    .filter((s) => s.trades >= 10)
    .sort((a, b) => b.expectancyPct - a.expectancyPct)[0];
  if (bestRegime) {
    notes.push(
      `Confirmed breakouts pay best in ${bestRegime.regime} tape (${bestRegime.expectancyPct.toFixed(2)}% expectancy over ${bestRegime.trades} signals).`,
    );
  }

  return {
    config: cfg,
    symbols: series.map((s) => s.symbol),
    from: trades[0]?.date ?? null,
    to: trades[trades.length - 1]?.date ?? null,
    barsScanned,
    trades,
    stats,
    regimeDays,
    edge: {
      confirmedWinRatePct: confirmed.winRatePct,
      failedWinRatePct: failed.winRatePct,
      winRateGapPp: confirmed.winRatePct - failed.winRatePct,
      confirmedAvgReturnPct: confirmed.avgReturnPct,
      failedAvgReturnPct: failed.avgReturnPct,
      avgReturnGapPct: confirmed.avgReturnPct - failed.avgReturnPct,
      verdict,
      notes,
    },
  };
}

/** Plain-text summary — used by the UI and by CLI/report tooling. */
export function formatBreakoutBacktestReport(report: BreakoutBacktestReport): string {
  const lines: string[] = [];
  lines.push(
    `BREAKOUT SIGNAL BACKTEST — ${report.symbols.length} symbols, ${report.from ?? "?"} → ${report.to ?? "?"}, ${report.trades.length} signals`,
  );
  lines.push(
    `horizon ${report.config.horizonBars}b, stop ${report.config.stopAtr} ATR, target ${report.config.targetAtr} ATR, cost ${report.config.costBps}bps`,
  );
  for (const s of report.stats) {
    if (!s.trades) continue;
    lines.push(
      `  ${s.cohort.padEnd(9)} ${String(s.regime).padEnd(8)} n=${String(s.trades).padStart(4)} win=${s.winRatePct.toFixed(1)}% avg=${s.avgReturnPct.toFixed(2)}% exp=${s.expectancyPct.toFixed(2)}% dd=${s.maxDrawdownPct.toFixed(1)}%`,
    );
  }
  lines.push(`VERDICT: ${report.edge.verdict}`);
  for (const n of report.edge.notes) lines.push(`  - ${n}`);
  return lines.join("\n");
}
