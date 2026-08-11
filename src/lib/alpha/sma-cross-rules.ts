// SMA crossover trading rules.
//
// Two independent crossover systems, both with configurable thresholds:
//
//   • Fast system — SMA20 vs SMA50. Short-horizon trend flips used to time
//     entries (bull cross) and to trim/exit stale positions (bear cross).
//   • Regime system — SMA50 vs SMA200 (the classic golden / death cross).
//     Slow, structural. A death cross blocks new buys outright and can force
//     a defensive exit; a golden cross upsizes buys.
//
// Every threshold is configurable so the rules can be tuned per risk profile
// and swept by the parameter optimiser. Crosses must clear a *separation*
// band (in %) to count — a raw SMA touch whipsaws constantly — and must be
// *fresh* (within `maxCrossAgeBars`) to act on, so we don't chase a cross
// that happened months ago.

import { smaDynamicSizeMultiplier, type SmaSizeResult } from "./sma-position-sizing";


export type SmaCrossRuleConfig = {
  enabled: boolean;
  /** Minimum |SMA20-SMA50|/SMA50 for a fast cross to count. 0.002 = 0.2%. */
  fastSeparationPct: number;
  /** Minimum |SMA50-SMA200|/SMA200 for a golden/death cross to count. */
  regimeSeparationPct: number;
  /** Bars the new ordering must persist before the cross is confirmed. */
  confirmBars: number;
  /** A cross older than this (in bars) is regime state, not a trade trigger. */
  maxCrossAgeBars: number;
  /** Require price on the correct side of SMA20 for a fast-cross buy. */
  requirePriceConfirmation: boolean;
  /** Buy size multiplier on a confirmed fast bull cross. */
  fastBullSizeMult: number;
  /** Extra buy size multiplier while SMA50 > SMA200 (golden regime). */
  goldenSizeMult: number;
  /** Buy size multiplier while SMA50 < SMA200 (death regime). 0 = block. */
  deathSizeMult: number;
  /** Fraction of a position sold on a confirmed fast bear cross. */
  fastBearSellFraction: number;
  /** Fraction sold on a fresh death cross. */
  deathSellFraction: number;
  /** Only sell on a bear cross when price is also below SMA50. */
  requirePriceConfirmationOnSell: boolean;

  // ---- Missing-data / normalization handling -------------------------
  /** Minimum usable bars before any cross signal is produced. */
  minBarsFast: number;
  /** Bars needed for the SMA50/200 regime. Below this, regime is unknown. */
  minBarsRegime: number;
  /**
   * Maximum share of the raw series that may be dropped as invalid
   * (non-finite, <= 0, duplicated timestamps) before the series is treated
   * as untrustworthy and all signals are suppressed.
   */
  maxDroppedFraction: number;
  /**
   * Maximum share of the recent window that may be flat repeats (a stale
   * price feed) before cross detection is suppressed.
   */
  maxStaleFraction: number;
  /**
   * Buy size multiplier when the long-term regime is unknown — typically a
   * newly listed symbol with <200 bars. Never blocks; just sizes down.
   */
  unknownRegimeSizeMult: number;

  // ---- Dynamic (conviction-scaled) sizing -----------------------------
  /**
   * Separation at which regime conviction saturates. Between
   * `regimeSeparationPct` and this, the golden/death size effect ramps
   * proportionally instead of switching on as a step.
   */
  regimeSaturationPct: number;
  /** Separation at which fast-cross conviction saturates. */
  fastSaturationPct: number;
  /**
   * How much a cross's size effect decays as it ages towards
   * `maxCrossAgeBars`. 0 = no decay, 0.6 = a stale cross keeps 40% of it.
   */
  freshnessWeight: number;
  /** Buy multiplier floor when a fast bear cross fires at full conviction. */
  fastBearBuyMult: number;
  /** Lower bound on the combined SMA size multiplier for this risk level. */
  minSizeMult: number;
  /** Upper bound on the combined SMA size multiplier for this risk level. */
  maxSizeMult: number;
};

export const DEFAULT_SMA_CROSS_RULES: SmaCrossRuleConfig = {
  enabled: true,
  fastSeparationPct: 0.002,
  regimeSeparationPct: 0.005,
  confirmBars: 1,
  maxCrossAgeBars: 10,
  requirePriceConfirmation: true,
  fastBullSizeMult: 1.15,
  goldenSizeMult: 1.1,
  deathSizeMult: 0,
  fastBearSellFraction: 0.5,
  deathSellFraction: 1,
  requirePriceConfirmationOnSell: true,
  minBarsFast: 50,
  minBarsRegime: 200,
  maxDroppedFraction: 0.2,
  maxStaleFraction: 0.5,
  unknownRegimeSizeMult: 0.75,
  regimeSaturationPct: 0.06,
  fastSaturationPct: 0.025,
  freshnessWeight: 0.5,
  fastBearBuyMult: 0.5,
  minSizeMult: 0.35,
  maxSizeMult: 1.3,
};

/** How much of the model is trustworthy for this symbol. */
export type SmaDataQuality = "full" | "partial" | "insufficient";

export type SmaCrossState = {
  price: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  /** Fresh confirmed fast cross, if any. */
  fastCross: "bull" | "bear" | null;
  /** Bars since the fast ordering last flipped (null when never/unknown). */
  fastCrossAgeBars: number | null;
  /** Fresh confirmed regime cross, if any. */
  regimeCross: "golden" | "death" | null;
  regimeCrossAgeBars: number | null;
  /** Current regime; null when history is too short (newly listed). */
  regime: "golden" | "death" | null;
  fastSeparationPct: number | null;
  regimeSeparationPct: number | null;

  // ---- Data-quality telemetry ----------------------------------------
  /** Usable bars after normalization. */
  bars: number;
  /** Bars dropped from the raw input as invalid. */
  droppedBars: number;
  quality: SmaDataQuality;
  /** True when there is not enough history for SMA200. */
  regimeUnknown: boolean;
  /** Human-readable notes on why signals were degraded/suppressed. */
  warnings: string[];
};

/**
 * Coerce an arbitrary close series into a clean, strictly positive, finite
 * number array. Accepts numbers, numeric strings and null/undefined holes —
 * price caches, broker payloads and backfills all produce these.
 * Ordering is preserved (oldest → newest); holes are dropped, not filled,
 * so an SMA is never smeared with a fabricated price.
 */
export function normalizeCloses(input: unknown): { closes: number[]; dropped: number } {
  if (!Array.isArray(input)) return { closes: [], dropped: 0 };
  const closes: number[] = [];
  let dropped = 0;
  for (const raw of input) {
    const n =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim() !== ""
          ? Number(raw)
          : NaN;
    if (Number.isFinite(n) && n > 0) closes.push(n);
    else dropped++;
  }
  return { closes, dropped };
}

/** Fraction of the last `window` bars that repeat the previous close exactly. */
function staleFraction(closes: number[], window: number): number {
  const start = Math.max(1, closes.length - window);
  let repeats = 0;
  let counted = 0;
  for (let i = start; i < closes.length; i++) {
    counted++;
    if (closes[i] === closes[i - 1]) repeats++;
  }
  return counted > 0 ? repeats / counted : 0;
}

function smaAt(closes: number[], period: number, offsetFromEnd: number): number | null {
  const end = closes.length - offsetFromEnd;
  if (end < period) return null;
  let sum = 0;
  for (let i = end - period; i < end; i++) sum += closes[i]!;
  const avg = sum / period;
  return Number.isFinite(avg) && avg > 0 ? avg : null;
}

/**
 * Detect the most recent confirmed crossover between two SMA periods.
 * Returns the direction and how many bars ago the ordering flipped.
 */
function detectCross(
  closes: number[],
  fast: number,
  slow: number,
  separationPct: number,
  confirmBars: number,
  lookback: number,
): { dir: "up" | "down" | null; ageBars: number | null; separation: number | null } {
  const nowFast = smaAt(closes, fast, 0);
  const nowSlow = smaAt(closes, slow, 0);
  if (nowFast == null || nowSlow == null || !(nowSlow > 0)) {
    return { dir: null, ageBars: null, separation: null };
  }
  const separation = (nowFast - nowSlow) / nowSlow;
  const above = nowFast > nowSlow;

  // Walk back to find where the ordering last differed.
  let ageBars: number | null = null;
  for (let back = 1; back <= lookback; back++) {
    const f = smaAt(closes, fast, back);
    const s = smaAt(closes, slow, back);
    if (f == null || s == null) break;
    if (f > s !== above) {
      ageBars = back;
      break;
    }
  }
  if (ageBars == null) return { dir: null, ageBars: null, separation };
  // The new ordering must have held for `confirmBars` bars, the separation
  // must clear the band, and the flip must be recent enough to act on.
  if (ageBars < Math.max(1, confirmBars)) return { dir: null, ageBars, separation };
  if (Math.abs(separation) < separationPct) return { dir: null, ageBars, separation };
  return { dir: above ? "up" : "down", ageBars, separation };
}

/**
 * Build the crossover state from a close series (oldest → newest).
 *
 * Degrades instead of throwing: messy input is normalized, short history
 * yields a `partial` state with `regimeUnknown = true`, and genuinely
 * unusable input returns null so callers fall back to neutral behaviour.
 */
export function computeSmaCrossState(
  input: unknown,
  cfg: SmaCrossRuleConfig = DEFAULT_SMA_CROSS_RULES,
): SmaCrossState | null {
  const { closes, dropped } = normalizeCloses(input);
  const rawLen = Array.isArray(input) ? input.length : 0;
  const bars = closes.length;
  if (bars === 0) return null;

  const price = closes[bars - 1]!;
  const warnings: string[] = [];

  // Too much of the raw series was unusable — don't trust any SMA from it.
  if (rawLen > 0 && dropped / rawLen > cfg.maxDroppedFraction) {
    return {
      price, sma20: null, sma50: null, sma200: null,
      fastCross: null, fastCrossAgeBars: null,
      regimeCross: null, regimeCrossAgeBars: null, regime: null,
      fastSeparationPct: null, regimeSeparationPct: null,
      bars, droppedBars: dropped, quality: "insufficient", regimeUnknown: true,
      warnings: [`${dropped}/${rawLen} bars invalid — SMA signals suppressed`],
    };
  }
  if (dropped > 0) warnings.push(`${dropped} invalid bar(s) dropped`);

  const minFast = Math.max(20, cfg.minBarsFast);
  if (bars < minFast) {
    return {
      price, sma20: smaAt(closes, 20, 0), sma50: smaAt(closes, 50, 0), sma200: null,
      fastCross: null, fastCrossAgeBars: null,
      regimeCross: null, regimeCrossAgeBars: null, regime: null,
      fastSeparationPct: null, regimeSeparationPct: null,
      bars, droppedBars: dropped, quality: "insufficient", regimeUnknown: true,
      warnings: [...warnings, `only ${bars} bars (<${minFast}) — newly listed / sparse history`],
    };
  }

  // A stale feed repeats the last close; SMAs converge and cross spuriously.
  const stale = staleFraction(closes, Math.min(bars, 60));
  if (stale > cfg.maxStaleFraction) {
    warnings.push(`${(stale * 100).toFixed(0)}% flat closes — cross detection suppressed`);
  }
  const staleSuppressed = stale > cfg.maxStaleFraction;

  const lookback = Math.max(cfg.maxCrossAgeBars, cfg.confirmBars) + 2;
  const fast = staleSuppressed
    ? { dir: null, ageBars: null, separation: null as number | null }
    : detectCross(closes, 20, 50, cfg.fastSeparationPct, cfg.confirmBars, lookback);

  const hasRegimeHistory = bars >= Math.max(200, cfg.minBarsRegime);
  const regime = hasRegimeHistory && !staleSuppressed
    ? detectCross(closes, 50, 200, cfg.regimeSeparationPct, cfg.confirmBars, lookback)
    : { dir: null, ageBars: null, separation: null as number | null };

  const sma20 = smaAt(closes, 20, 0);
  const sma50 = smaAt(closes, 50, 0);
  const sma200 = hasRegimeHistory ? smaAt(closes, 200, 0) : null;
  if (!hasRegimeHistory) {
    warnings.push(`${bars} bars — no SMA200 yet, long-term regime unknown`);
  }

  const fresh = (age: number | null) => age != null && age <= cfg.maxCrossAgeBars;

  return {
    price,
    sma20,
    sma50,
    sma200,
    fastCross: fast.dir && fresh(fast.ageBars) ? (fast.dir === "up" ? "bull" : "bear") : null,
    fastCrossAgeBars: fast.ageBars,
    regimeCross:
      regime.dir && fresh(regime.ageBars) ? (regime.dir === "up" ? "golden" : "death") : null,
    regimeCrossAgeBars: regime.ageBars,
    regime:
      sma50 != null && sma200 != null && sma200 > 0
        ? sma50 > sma200
          ? "golden"
          : "death"
        : null,
    fastSeparationPct: fast.separation,
    regimeSeparationPct: regime.separation,
    bars,
    droppedBars: dropped,
    quality: hasRegimeHistory && !staleSuppressed ? "full" : "partial",
    regimeUnknown: !hasRegimeHistory,
    warnings,
  };
}

export type SmaCrossBuyRule = {
  /** false = do not open/add to this position at all. */
  allow: boolean;
  /** Size multiplier applied to the intended notional when allowed. */
  sizeMultiplier: number;
  reason: string;
  /** Conviction breakdown behind the multiplier (null when not sized). */
  sizing: SmaSizeResult | null;
};

/**
 * Buy-side rule: a death regime vetoes new longs (unless the risk profile
 * allows reduced size), and everything else is sized by conviction —
 * separation depth and cross freshness — inside the risk profile's bounds.
 */
export function smaCrossBuyRule(
  state: SmaCrossState | null | undefined,
  cfg: SmaCrossRuleConfig = DEFAULT_SMA_CROSS_RULES,
): SmaCrossBuyRule {
  if (!cfg.enabled || !state) {
    return { allow: true, sizeMultiplier: 1, reason: "SMA cross rules off / no data", sizing: null };
  }

  // 0. Missing / untrustworthy data never blocks a trade — the rest of the
  // stack decides. Sparse names simply get no SMA boost.
  if (state.quality === "insufficient") {
    return {
      allow: true,
      sizeMultiplier: 1,
      reason: state.warnings[0] ?? "insufficient SMA history — neutral",
      sizing: null,
    };
  }

  // 1. Regime veto — a death cross blocks discretionary longs outright when
  // the profile sets `deathSizeMult` to 0. Profiles that allow reduced size
  // fall through to the conviction sizer, which scales the cut by how deep
  // the death cross actually is.
  if (state.regime === "death" && !(cfg.deathSizeMult > 0)) {
    const sep = ((state.regimeSeparationPct ?? 0) * 100).toFixed(2);
    return {
      allow: false,
      sizeMultiplier: 0,
      reason: `death cross regime (SMA50 ${sep}% vs SMA200) — new buys blocked`,
      sizing: null,
    };
  }

  const sizing = smaDynamicSizeMultiplier(state, cfg);
  return {
    allow: true,
    sizeMultiplier: sizing.mult,
    reason: sizing.notes.length ? sizing.notes.join("; ") : "no actionable SMA cross — full size",
    sizing,
  };
}

export type SmaCrossSellRule = {
  sell: boolean;
  /** Fraction of the held position to sell (0-1). */
  sellFraction: number;
  reason: string;
};

/** Sell-side rule: fresh death cross exits, fast bear cross trims. */
export function smaCrossSellRule(
  state: SmaCrossState | null | undefined,
  cfg: SmaCrossRuleConfig = DEFAULT_SMA_CROSS_RULES,
): SmaCrossSellRule {
  if (!cfg.enabled || !state) return { sell: false, sellFraction: 0, reason: "" };
  // Never force an exit off unreliable or incomplete history — a sparse feed
  // would otherwise liquidate healthy positions on a phantom cross.
  if (state.quality === "insufficient") return { sell: false, sellFraction: 0, reason: "" };

  const clampFrac = (f: number) => Math.max(0, Math.min(1, f));

  if (state.regimeCross === "death" && cfg.deathSellFraction > 0) {
    const sep = ((state.regimeSeparationPct ?? 0) * 100).toFixed(2);
    return {
      sell: true,
      sellFraction: clampFrac(cfg.deathSellFraction),
      reason: `death cross — SMA50 crossed below SMA200 ${state.regimeCrossAgeBars}d ago (${sep}% apart)`,
    };
  }

  if (state.fastCross === "bear" && cfg.fastBearSellFraction > 0) {
    const priceOk =
      !cfg.requirePriceConfirmationOnSell || (state.sma50 != null && state.price < state.sma50);
    if (priceOk) {
      const sep = ((state.fastSeparationPct ?? 0) * 100).toFixed(2);
      return {
        sell: true,
        sellFraction: clampFrac(cfg.fastBearSellFraction),
        reason: `SMA20 crossed below SMA50 ${state.fastCrossAgeBars}d ago (${sep}% apart) — trend exit`,
      };
    }
  }

  return { sell: false, sellFraction: 0, reason: "" };
}
