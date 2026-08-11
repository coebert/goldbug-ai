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
};

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
  /** Current regime, independent of freshness. */
  regime: "golden" | "death" | null;
  fastSeparationPct: number | null;
  regimeSeparationPct: number | null;
};

function smaAt(closes: number[], period: number, offsetFromEnd: number): number | null {
  const end = closes.length - offsetFromEnd;
  if (end < period) return null;
  let sum = 0;
  for (let i = end - period; i < end; i++) sum += closes[i]!;
  return sum / period;
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

/** Build the crossover state from a close series (oldest → newest). */
export function computeSmaCrossState(
  closes: number[],
  cfg: SmaCrossRuleConfig = DEFAULT_SMA_CROSS_RULES,
): SmaCrossState | null {
  if (!Array.isArray(closes) || closes.length < 50) return null;
  const price = closes[closes.length - 1]!;
  if (!Number.isFinite(price) || price <= 0) return null;

  const lookback = Math.max(cfg.maxCrossAgeBars, cfg.confirmBars) + 2;
  const fast = detectCross(closes, 20, 50, cfg.fastSeparationPct, cfg.confirmBars, lookback);
  const regime = detectCross(closes, 50, 200, cfg.regimeSeparationPct, cfg.confirmBars, lookback);

  const sma20 = smaAt(closes, 20, 0);
  const sma50 = smaAt(closes, 50, 0);
  const sma200 = smaAt(closes, 200, 0);

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
  };
}

export type SmaCrossBuyRule = {
  /** false = do not open/add to this position at all. */
  allow: boolean;
  /** Size multiplier applied to the intended notional when allowed. */
  sizeMultiplier: number;
  reason: string;
};

/** Buy-side rule: golden regime upsizes, death regime blocks (by default). */
export function smaCrossBuyRule(
  state: SmaCrossState | null | undefined,
  cfg: SmaCrossRuleConfig = DEFAULT_SMA_CROSS_RULES,
): SmaCrossBuyRule {
  if (!cfg.enabled || !state) {
    return { allow: true, sizeMultiplier: 1, reason: "SMA cross rules off / no data" };
  }

  // 1. Regime gate first — a death cross vetoes discretionary longs.
  if (state.regime === "death") {
    const mult = Math.max(0, cfg.deathSizeMult);
    const sep = ((state.regimeSeparationPct ?? 0) * 100).toFixed(2);
    if (mult <= 0) {
      return {
        allow: false,
        sizeMultiplier: 0,
        reason: `death cross regime (SMA50 ${sep}% vs SMA200) — new buys blocked`,
      };
    }
    return {
      allow: true,
      sizeMultiplier: mult,
      reason: `death cross regime (SMA50 ${sep}% vs SMA200) — size ×${mult.toFixed(2)}`,
    };
  }

  let mult = 1;
  const notes: string[] = [];

  if (state.regimeCross === "golden" || state.regime === "golden") {
    mult *= cfg.goldenSizeMult;
    notes.push(
      state.regimeCross === "golden"
        ? `fresh golden cross (${state.regimeCrossAgeBars}d ago)`
        : "golden regime",
    );
  }

  if (state.fastCross === "bull") {
    const priceOk =
      !cfg.requirePriceConfirmation || (state.sma20 != null && state.price > state.sma20);
    if (priceOk) {
      mult *= cfg.fastBullSizeMult;
      notes.push(`SMA20↑SMA50 (${state.fastCrossAgeBars}d ago)`);
    } else {
      notes.push("SMA20↑SMA50 unconfirmed (px<SMA20)");
    }
  } else if (state.fastCross === "bear") {
    // Fast trend just rolled over inside a golden regime — half size.
    mult *= 0.5;
    notes.push("SMA20↓SMA50 — half size");
  }

  return {
    allow: true,
    sizeMultiplier: Math.max(0, mult),
    reason: notes.length ? notes.join("; ") : "no fresh SMA cross",
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
