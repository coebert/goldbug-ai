// Range-breakout detection — evidence-based, not eyeballed.
//
// A breakout only earns a positive score when the tape provides *all* of the
// classical evidence that separates real expansions from noise:
//
//   1. A genuine base. The prior N bars must have traded in a compressed
//      range (range width <= maxBasePct of the mid) for at least
//      `minBaseBars`. Without a base there is no "range" to break out of.
//   2. A decisive penetration. The close must clear the Donchian channel
//      extreme of the base by at least `minPenetrationAtr` ATRs. A one-tick
//      poke through a prior high is the single most common fakeout.
//   3. Volume expansion. Breakout-bar volume must be >= `minVolumeRatio` x
//      the 20-day average. Range expansions on thin volume revert.
//   4. Confirmation. At least `confirmBars` consecutive closes must hold
//      above (below) the broken level; a single close is "pending", not
//      confirmed.
//   5. A clean failure history. We count how often the symbol pierced its
//      own Donchian extreme over the lookback and closed back inside within
//      `failWindowBars`. A high historical false-breakout rate discounts the
//      score — some names simply do not trend.
//
// The detector is pure (candles in, evidence out), symmetric (upside
// breakouts and downside breakdowns), and never throws on short history.

import type { AlphaScore, FeatureLike } from "./types";
import { clamp1 } from "./types";

export type BreakoutConfig = {
  /** Donchian lookback used for the channel extreme (excludes the current bar). */
  channelBars: number;
  /** Minimum number of bars that must form the pre-breakout base. */
  minBaseBars: number;
  /** Base is only a "range" if (high-low)/mid <= this over the base window. */
  maxBasePct: number;
  /** Close must clear the level by at least this many ATRs. */
  minPenetrationAtr: number;
  /** Breakout-bar volume must be at least this multiple of ADV20. */
  minVolumeRatio: number;
  /** Consecutive closes beyond the level required to call it confirmed. */
  confirmBars: number;
  /** A pierce that closes back inside within this many bars counts as failed. */
  failWindowBars: number;
  /** How many bars back we scan for historical false breakouts. */
  historyBars: number;
  /** Breakouts older than this are stale — no longer actionable as entries. */
  maxAgeBars: number;
};

export const DEFAULT_BREAKOUT_CONFIG: BreakoutConfig = {
  channelBars: 55,
  minBaseBars: 20,
  maxBasePct: 0.18,
  minPenetrationAtr: 0.25,
  minVolumeRatio: 1.4,
  confirmBars: 2,
  failWindowBars: 3,
  historyBars: 250,
  maxAgeBars: 10,
};

export type BreakoutState =
  | "none" // inside the range
  | "pending" // cleared the level but not yet confirmed
  | "confirmed" // cleared and held
  | "failed" // cleared then closed back inside
  | "extended"; // confirmed but too old / too far to chase

export type BreakoutEvidence = {
  state: BreakoutState;
  direction: "up" | "down" | null;
  /** Donchian extreme that was broken (or the nearest one when inside). */
  level: number | null;
  /** Channel extremes of the current lookback. */
  channel_high: number | null;
  channel_low: number | null;
  /** Distance from the last close to the upper channel, in ATRs (>0 = below). */
  distance_to_high_atr: number | null;
  /** Penetration beyond the level in ATRs (0 when inside the range). */
  penetration_atr: number;
  /** Base range width as a fraction of the base mid-price. */
  base_width_pct: number | null;
  /** Bars in the qualifying base. */
  base_bars: number;
  /** Breakout-bar volume / ADV20. */
  volume_ratio: number | null;
  /** Consecutive closes held beyond the level. */
  bars_since_breakout: number;
  /** Historical pierce attempts and how many closed back inside. */
  prior_attempts: number;
  prior_failures: number;
  false_breakout_rate: number;
  /** 0..1 quality; combines base, penetration, volume, confirmation, history. */
  quality: number;
  /** Actionable entry (confirmed, fresh, decent quality, clean history). */
  actionable: boolean;
  reasons: string[];
};

export type BreakoutCandle = { high: number; low: number; close: number; volume?: number };

export const EMPTY_BREAKOUT: BreakoutEvidence = {
  state: "none",
  direction: null,
  level: null,
  channel_high: null,
  channel_low: null,
  distance_to_high_atr: null,
  penetration_atr: 0,
  base_width_pct: null,
  base_bars: 0,
  volume_ratio: null,
  bars_since_breakout: 0,
  prior_attempts: 0,
  prior_failures: 0,
  false_breakout_rate: 0,
  quality: 0,
  actionable: false,
  reasons: ["insufficient history"],
};

function atrOf(candles: BreakoutCandle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  return atr > 0 ? atr : null;
}

/** Count historical pierces of the trailing Donchian extreme that failed. */
function falseBreakoutHistory(
  candles: BreakoutCandle[],
  cfg: BreakoutConfig,
): { attempts: number; failures: number } {
  let attempts = 0;
  let failures = 0;
  const start = Math.max(cfg.channelBars + 1, candles.length - cfg.historyBars);
  let i = start;
  while (i < candles.length - cfg.failWindowBars) {
    const window = candles.slice(i - cfg.channelBars, i);
    const hi = Math.max(...window.map((c) => c.high));
    if (candles[i].close > hi) {
      attempts++;
      const after = candles.slice(i + 1, i + 1 + cfg.failWindowBars);
      if (after.some((c) => c.close < hi)) failures++;
      i += cfg.failWindowBars; // don't double-count the same event
      continue;
    }
    i++;
  }
  return { attempts, failures };
}

export function detectBreakout(
  candles: BreakoutCandle[],
  config: Partial<BreakoutConfig> = {},
): BreakoutEvidence {
  const cfg: BreakoutConfig = { ...DEFAULT_BREAKOUT_CONFIG, ...config };
  if (!Array.isArray(candles) || candles.length < cfg.minBaseBars + 5) return { ...EMPTY_BREAKOUT };

  const lookback = Math.min(cfg.channelBars, candles.length - 1);
  const last = candles[candles.length - 1];
  const prior = candles.slice(candles.length - 1 - lookback, candles.length - 1);
  if (prior.length < cfg.minBaseBars) return { ...EMPTY_BREAKOUT };

  const channelHigh = Math.max(...prior.map((c) => c.high));
  const channelLow = Math.min(...prior.map((c) => c.low));
  const atr = atrOf(candles) ?? null;

  // Base quality: measured over the bars immediately preceding the breakout.
  const baseBars = Math.min(prior.length, Math.max(cfg.minBaseBars, Math.round(lookback / 2)));
  const base = prior.slice(prior.length - baseBars);
  const baseHigh = Math.max(...base.map((c) => c.high));
  const baseLow = Math.min(...base.map((c) => c.low));
  const baseMid = (baseHigh + baseLow) / 2;
  const baseWidthPct = baseMid > 0 ? (baseHigh - baseLow) / baseMid : null;

  const adv = (() => {
    const vols = candles.slice(-21, -1).map((c) => c.volume ?? 0).filter((v) => v > 0);
    if (vols.length < 5) return null;
    return vols.reduce((a, b) => a + b, 0) / vols.length;
  })();
  const volumeRatio = adv && last.volume ? last.volume / adv : null;

  const history = falseBreakoutHistory(candles, cfg);
  const falseRate = history.attempts > 0 ? history.failures / history.attempts : 0;

  const distanceToHighAtr = atr ? (channelHigh - last.close) / atr : null;

  const evidence: BreakoutEvidence = {
    state: "none",
    direction: null,
    level: channelHigh,
    channel_high: channelHigh,
    channel_low: channelLow,
    distance_to_high_atr: distanceToHighAtr,
    penetration_atr: 0,
    base_width_pct: baseWidthPct,
    base_bars: baseBars,
    volume_ratio: volumeRatio,
    bars_since_breakout: 0,
    prior_attempts: history.attempts,
    prior_failures: history.failures,
    false_breakout_rate: falseRate,
    quality: 0,
    actionable: false,
    reasons: [],
  };

  const up = last.close > channelHigh;
  const down = last.close < channelLow;
  if (!up && !down) {
    evidence.reasons.push(
      distanceToHighAtr != null
        ? `inside range, ${distanceToHighAtr.toFixed(1)} ATR below ${channelHigh.toFixed(2)}`
        : "inside range",
    );
    return evidence;
  }

  const direction: "up" | "down" = up ? "up" : "down";
  const level = up ? channelHigh : channelLow;
  const penetration = atr ? Math.abs(last.close - level) / atr : 0;

  // How many consecutive recent closes held beyond the level?
  let held = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    if (up ? c.close > level : c.close < level) held++;
    else break;
  }
  // Did a recent pierce already fail (closed back inside within the window)?
  const recent = candles.slice(-(cfg.failWindowBars + held + 1), candles.length - held);
  const pierced = recent.some((c) => (up ? c.close > level : c.close < level));
  const failedRecently = pierced && held < cfg.confirmBars;

  evidence.direction = direction;
  evidence.level = level;
  evidence.penetration_atr = penetration;
  evidence.bars_since_breakout = held;

  const hasBase = baseWidthPct != null && baseWidthPct <= cfg.maxBasePct && baseBars >= cfg.minBaseBars;
  const decisive = penetration >= cfg.minPenetrationAtr;
  const volumeOk = volumeRatio == null ? false : volumeRatio >= cfg.minVolumeRatio;
  const confirmed = held >= cfg.confirmBars;

  if (hasBase) evidence.reasons.push(`base ${baseBars}b ${(baseWidthPct! * 100).toFixed(1)}% wide`);
  else evidence.reasons.push("no compressed base");
  evidence.reasons.push(`${direction === "up" ? "above" : "below"} ${level.toFixed(2)} by ${penetration.toFixed(2)} ATR`);
  if (volumeRatio != null) evidence.reasons.push(`vol ${volumeRatio.toFixed(2)}x ADV20`);
  else evidence.reasons.push("no volume data");
  if (history.attempts > 0) evidence.reasons.push(`${history.failures}/${history.attempts} prior breakouts failed`);

  if (failedRecently) {
    evidence.state = "failed";
    evidence.reasons.push("closed back inside the range — failed breakout");
    return evidence;
  }

  evidence.state = confirmed ? (held > cfg.maxAgeBars ? "extended" : "confirmed") : "pending";

  // Quality: weighted evidence, each component in [0,1].
  const baseScore = hasBase ? Math.min(1, cfg.maxBasePct / Math.max(baseWidthPct!, 1e-6) / 2) : 0;
  const penScore = Math.min(1, penetration / (cfg.minPenetrationAtr * 4));
  const volScore = volumeRatio == null ? 0.3 : Math.min(1, volumeRatio / (cfg.minVolumeRatio * 1.5));
  const confirmScore = Math.min(1, held / cfg.confirmBars);
  const historyScore = 1 - Math.min(1, falseRate);
  let quality =
    0.25 * baseScore + 0.2 * penScore + 0.2 * volScore + 0.2 * confirmScore + 0.15 * historyScore;
  if (evidence.state === "extended") quality *= 0.5;
  if (!decisive) quality *= 0.5;
  evidence.quality = Math.max(0, Math.min(1, quality));

  evidence.actionable =
    evidence.state === "confirmed" && hasBase && decisive && volumeOk && falseRate < 0.7 && evidence.quality >= 0.45;
  if (evidence.actionable) evidence.reasons.push("actionable breakout");

  return evidence;
}

/**
 * Alpha model wrapper. Reads the pre-computed evidence attached to the
 * candidate feature row (built server-side from candles) and maps it to the
 * bounded [-1, 1] alpha space. Upside breakouts score positive, breakdowns
 * negative, failed breakouts score negative (a failed breakout is one of the
 * more reliable short-term reversal tells).
 */
export function scoreBreakout(f: FeatureLike): AlphaScore {
  const b = f.breakout ?? null;
  if (!b || b.direction == null || b.state === "none") {
    return {
      symbol: f.symbol,
      kind: "breakout",
      score: 0,
      reason: b?.reasons?.[0] ?? "no breakout signal",
    };
  }

  const sign = b.direction === "up" ? 1 : -1;
  let magnitude = b.quality;
  if (b.state === "pending") magnitude *= 0.5;
  if (b.state === "extended") magnitude *= 0.4;

  if (b.state === "failed") {
    // Failed upside breakout = bearish; failed breakdown = bullish.
    return {
      symbol: f.symbol,
      kind: "breakout",
      score: clamp1(-sign * 0.5),
      reason: `failed ${b.direction === "up" ? "breakout" : "breakdown"} at ${b.level?.toFixed(2) ?? "?"}`,
    };
  }

  return {
    symbol: f.symbol,
    kind: "breakout",
    score: clamp1(sign * magnitude),
    reason: `${b.state} ${b.direction === "up" ? "breakout" : "breakdown"} — ${b.reasons.slice(0, 3).join(", ")}`,
  };
}

/** Compact prompt block listing the actionable breakouts / breakdowns. */
export function formatBreakoutBlock(
  rows: Array<{ symbol: string; breakout?: BreakoutEvidence | null }>,
  topN = 8,
): string {
  const live = rows
    .filter((r) => r.breakout && r.breakout.state !== "none")
    .sort((a, b) => (b.breakout!.quality ?? 0) - (a.breakout!.quality ?? 0))
    .slice(0, topN);
  if (!live.length) return "RANGE BREAKOUTS: none — every candidate is inside its recent range.";
  const lines = live.map((r) => {
    const b = r.breakout!;
    return `  ${r.symbol} ${b.state} ${b.direction === "up" ? "↑" : "↓"} lvl=${b.level?.toFixed(2) ?? "?"} q=${b.quality.toFixed(2)}${b.actionable ? " ACTIONABLE" : ""} [${b.reasons.slice(0, 3).join("; ")}]`;
  });
  return [
    "RANGE BREAKOUTS (Donchian base + ATR penetration + volume + confirmation):",
    ...lines,
    "Only 'confirmed'/ACTIONABLE breakouts justify chasing strength; 'pending' needs another close, 'failed' is a reversal tell, 'extended' is too late to chase.",
  ].join("\n");
}
