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

/** Market-cap band, always judged in USD. */
export type ScaleTier = "mega" | "large" | "mid" | "small" | "micro";

/**
 * Rough USD value of one unit of each reporting currency.
 *
 * Market caps arrive in whatever currency the company reports in, so a Tokyo
 * name reporting in yen looked ~150x bigger than an identical US one and a
 * European mid cap looked smaller than it is. The tiers are decade-wide bands,
 * so slow-moving reference rates are accurate enough and keep this module pure
 * (no IO, no clock). Unknown currencies are treated as USD.
 */
const USD_PER_UNIT: Record<string, number> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  GBP_PENCE: 0.0127,
  GBX: 0.0127,
  GBp: 0.0127,
  CHF: 1.15,
  SEK: 0.095,
  NOK: 0.093,
  DKK: 0.145,
  JPY: 0.0067,
  AUD: 0.66,
  CAD: 0.73,
  HKD: 0.128,
  SGD: 0.74,
  PLN: 0.25,
  CZK: 0.043,
  ILS: 0.27,
};

/** Convert a reported market cap into USD for banding purposes. */
export function marketCapUsd(
  marketCap: number | null | undefined,
  currency?: string | null,
): number | null {
  if (marketCap == null || !Number.isFinite(marketCap) || marketCap <= 0) return null;
  const raw = (currency ?? "USD").trim();
  const rate = USD_PER_UNIT[raw] ?? USD_PER_UNIT[raw.toUpperCase()] ?? 1;
  return marketCap * rate;
}

export function scaleTier(
  marketCap: number | null | undefined,
  currency?: string | null,
): ScaleTier | null {
  const usd = marketCapUsd(marketCap, currency);
  if (usd == null) return null;
  if (usd >= 200e9) return "mega";
  if (usd >= 50e9) return "large";
  if (usd >= 10e9) return "mid";
  if (usd >= 2e9) return "small";
  return "micro";
}

/** Bounded score nudge by size: deep, liquid names cost less to get in and out of. */
export function scaleBonus(
  marketCap: number | null | undefined,
  currency?: string | null,
): number {
  switch (scaleTier(marketCap, currency)) {
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
