// Scale and quality tilt for the buy side.
//
// The account kept re-trading the same small, cheap names because the ratio
// thresholds in `fundamentals/score.ts` are pure "cheapness" ramps: a large,
// highly profitable compounder on a 35x multiple scores worse than a shrinking
// small cap on 8x, even though only one of them has ever paid for its dealing
// costs. Two pure adjustments fix that without loosening any risk rule:
//
//   qualityTolerance()  widens the valuation "expensive" bound in proportion to
//                       measured business quality (ROE, net margin, growth, FCF
//                       yield). Quality earns a higher multiple; it does not
//                       earn a free pass — the ramp is bounded.
//   scaleBonus()        small bounded nudge on the overall score by market cap,
//                       so bigger, deeper, cheaper-to-trade names win ties.
//
// Both are bounded and deterministic, and neither can block or force a trade.

/** Market-cap band, in the currency the accounts are reported in. */
export type ScaleTier = "mega" | "large" | "mid" | "small" | "micro";

export function scaleTier(marketCap: number | null | undefined): ScaleTier | null {
  if (marketCap == null || !Number.isFinite(marketCap) || marketCap <= 0) return null;
  if (marketCap >= 200e9) return "mega";
  if (marketCap >= 50e9) return "large";
  if (marketCap >= 10e9) return "mid";
  if (marketCap >= 2e9) return "small";
  return "micro";
}

/** Bounded score nudge by size: deep, liquid names cost less to get in and out of. */
export function scaleBonus(marketCap: number | null | undefined): number {
  switch (scaleTier(marketCap)) {
    case "mega":
      return 0.08;
    case "large":
      return 0.05;
    case "mid":
      return 0.02;
    case "small":
      return -0.03;
    case "micro":
      return -0.08;
    default:
      return 0;
  }
}

export type QualityInputs = {
  return_on_equity?: number | null;
  profit_margin?: number | null;
  revenue_growth?: number | null;
  free_cashflow?: number | null;
  market_cap?: number | null;
};

/**
 * How much more expensive a name is allowed to look before the valuation
 * pillar marks it down, expressed as a multiplier on the "bad" bound.
 *
 * 1.00 = no tolerance (ordinary business), up to 1.60 for a name that is highly
 * profitable, growing and cash generative. Missing data earns nothing.
 */
export function qualityTolerance(f: QualityInputs): number {
  let t = 1;
  const roe = f.return_on_equity;
  if (roe != null && Number.isFinite(roe)) {
    if (roe >= 0.3) t += 0.2;
    else if (roe >= 0.18) t += 0.12;
    else if (roe >= 0.1) t += 0.05;
  }
  const nm = f.profit_margin;
  if (nm != null && Number.isFinite(nm)) {
    if (nm >= 0.2) t += 0.15;
    else if (nm >= 0.12) t += 0.08;
  }
  const g = f.revenue_growth;
  if (g != null && Number.isFinite(g)) {
    if (g >= 0.2) t += 0.15;
    else if (g >= 0.1) t += 0.08;
    else if (g < 0) t -= 0.1;
  }
  const fcf = f.free_cashflow;
  const cap = f.market_cap;
  if (fcf != null && cap != null && Number.isFinite(fcf) && cap > 0) {
    const yieldPct = fcf / cap;
    if (yieldPct >= 0.04) t += 0.1;
    else if (yieldPct < 0) t -= 0.1;
  }
  return Math.max(0.85, Math.min(1.6, Number(t.toFixed(3))));
}
