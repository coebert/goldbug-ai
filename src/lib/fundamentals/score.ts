// Turn published company financials into a bounded, explainable score.
//
// Pure module — no IO, no clock reads beyond the caller-supplied `asOf`, so the
// whole thing is unit-testable and deterministic. Six pillars, each scored in
// [-1, 1] and each skipped when the company has not disclosed the inputs:
//
//   valuation      P/E, forward P/E, PEG, P/B, EV/EBITDA
//   profitability  gross / operating / net margin, ROE, ROA
//   growth         revenue growth, earnings growth, forward EPS estimates
//   balance_sheet  net debt vs equity, current ratio, free cash flow
//   shareholder    dividend yield and whether earnings cover the payout
//   analysts       published consensus rating and price target
//
// The overall score is the mean of the pillars that had data, so a company that
// only discloses part of the picture is not penalised for the missing half —
// but `coverage` is reported so the decision layer can discount thin data.

import type { Fundamentals, FundamentalsScore, FundamentalsSubscores } from "./types";
import { EMPTY_FUNDAMENTALS_SCORE } from "./types";
import { qualityTolerance, scaleBonus, scaleTier } from "../quality-scale";
import { isNonUsDeveloped, marketRegion, type MarketRegion } from "../market-region";

/** Currency the accounts (and therefore the market cap) are reported in. */
function reportingCurrency(f: Fundamentals): string | null {
  return f.financial_currency ?? f.currency ?? null;
}

const clamp1 = (x: number): number =>
  Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;

/** Mean of the defined numbers, or null when none are defined. */
function meanOf(parts: Array<number | null>): number | null {
  const xs = parts.filter((x): x is number => x != null && Number.isFinite(x));
  if (xs.length === 0) return null;
  return clamp1(xs.reduce((a, b) => a + b, 0) / xs.length);
}

/**
 * Score a "lower is better" ratio: `good` maps to +1, `bad` maps to -1,
 * with a linear ramp in between and clamping outside.
 */
function lowerBetter(value: number | null, good: number, bad: number): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  // Negative earnings make P/E and PEG meaningless rather than cheap.
  if (value <= 0) return null;
  return clamp1((bad - value) / (bad - good));
}

/** Score a "higher is better" level: `bad` maps to -1, `good` maps to +1. */
function higherBetter(value: number | null, bad: number, good: number): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return clamp1((value - bad) / (good - bad));
}

/**
 * A negative P/E or PEG means the company has no earnings to value, which is a
 * weakness — not a cheap multiple and not a neutral absence of data.
 */
function earningsMultiple(value: number | null, good: number, bad: number): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value <= 0) return -0.6;
  return lowerBetter(value, good, bad);
}

/**
 * Valuation, judged relative to business quality.
 *
 * A flat "cheap is good" ramp systematically prefers small, shrinking names
 * over large compounders. `qualityTolerance` widens the expensive bound in
 * proportion to measured returns, margins, growth and cash generation, so a
 * genuinely high-quality business is not marked down for trading above the
 * multiple of a struggling one. The tolerance is bounded (0.85x-1.60x).
 */
export function scoreValuation(f: Fundamentals): number | null {
  const t = qualityTolerance(f);
  return meanOf([
    earningsMultiple(f.trailing_pe, 10, 45 * t),
    earningsMultiple(f.forward_pe, 9, 38 * t),
    earningsMultiple(f.peg, 0.8, 3.5 * t),
    lowerBetter(f.price_to_book, 1, 12 * t),
    lowerBetter(f.ev_ebitda, 6, 25 * t),
  ]);
}

export function scoreProfitability(f: Fundamentals): number | null {
  return meanOf([
    higherBetter(f.gross_margin, 0.1, 0.55),
    higherBetter(f.operating_margin, 0, 0.25),
    higherBetter(f.profit_margin, 0, 0.18),
    higherBetter(f.return_on_equity, 0, 0.22),
    higherBetter(f.return_on_assets, 0, 0.1),
  ]);
}

export function scoreGrowth(f: Fundamentals): number | null {
  return meanOf([
    higherBetter(f.revenue_growth, -0.05, 0.18),
    higherBetter(f.earnings_growth, -0.1, 0.25),
    higherBetter(f.eps_growth_next_q, -0.05, 0.2),
    higherBetter(f.eps_growth_next_y, -0.05, 0.2),
  ]);
}

export function scoreBalanceSheet(f: Fundamentals): number | null {
  // debt_to_equity arrives as a percentage (78.4 means 0.78x).
  const gearing =
    f.debt_to_equity == null || !Number.isFinite(f.debt_to_equity)
      ? null
      : clamp1((150 - f.debt_to_equity) / 150);
  const netCash =
    f.total_cash != null && f.total_debt != null && f.market_cap
      ? clamp1(((f.total_cash - f.total_debt) / Math.max(1, f.market_cap)) * 5)
      : null;
  const fcf =
    f.free_cashflow != null && f.market_cap
      ? clamp1((f.free_cashflow / Math.max(1, f.market_cap)) * 20) // 5% FCF yield → +1
      : f.free_cashflow != null
        ? clamp1(Math.sign(f.free_cashflow))
        : null;
  return meanOf([gearing, netCash, fcf, higherBetter(f.current_ratio, 0.8, 2)]);
}

export function scoreShareholder(f: Fundamentals, region: MarketRegion = "us"): number | null {
  if (f.dividend_yield == null) return null;
  // European and Japanese blue chips distribute far more of their earnings
  // than US ones by convention, so a US payout bar marks the whole region
  // down. The "not covered at all" flag in financialFlags still bites.
  const coverBar = isNonUsDeveloped(region) ? 1 : 0.85;
  const yieldScore = higherBetter(f.dividend_yield, 0, isNonUsDeveloped(region) ? 0.06 : 0.05);
  // A payout above 100% of earnings is a cut risk, not a reward.
  const cover =
    f.payout_ratio == null || !Number.isFinite(f.payout_ratio)
      ? null
      : f.payout_ratio <= 0
        ? null
        : clamp1((coverBar - f.payout_ratio) / coverBar);
  return meanOf([yieldScore, cover]);
}

export function scoreAnalysts(f: Fundamentals, region: MarketRegion = "us"): number | null {
  // Consensus rating: 1 strong buy .. 5 strong sell. Ignore thin coverage.
  // Sell-side coverage outside the US is thinner even on the largest names,
  // so a US three-analyst floor silently deletes the pillar for Europe/Japan.
  const minAnalysts = isNonUsDeveloped(region) ? 2 : 3;
  const rating =
    f.analyst_mean != null && (f.analyst_count ?? 0) >= minAnalysts
      ? clamp1((3 - f.analyst_mean) / 1.5)
      : null;
  const upside =
    f.target_mean_price != null && f.current_price != null && f.current_price > 0
      ? clamp1(((f.target_mean_price - f.current_price) / f.current_price) * 4) // +25% → +1
      : null;
  return meanOf([rating, upside]);
}

/** Days between two ISO dates, or null when either is unparseable. */
function daysBetween(fromISO: string, toISO: string | null): number | null {
  if (!toISO) return null;
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** Hard financial risks. These are surfaced verbatim to the AI and the audit log. */
export function financialFlags(f: Fundamentals, asOf: string): string[] {
  const flags: string[] = [];
  if (f.profit_margin != null && f.profit_margin < 0) flags.push("loss-making (negative net margin)");
  if (f.free_cashflow != null && f.free_cashflow < 0) flags.push("negative free cash flow");
  if (f.debt_to_equity != null && f.debt_to_equity > 200)
    flags.push(`high leverage (debt/equity ${(f.debt_to_equity / 100).toFixed(1)}x)`);
  if (f.current_ratio != null && f.current_ratio < 0.8)
    flags.push(`weak liquidity (current ratio ${f.current_ratio.toFixed(2)})`);
  if (f.payout_ratio != null && f.payout_ratio > 1)
    flags.push(`dividend not covered by earnings (payout ${(f.payout_ratio * 100).toFixed(0)}%)`);
  // "Expensive" is quality-relative: a 30%-ROE compounder on 70x is not the
  // same warning as a no-growth business on 70x. Bounded by qualityTolerance.
  const peLimit = 60 * qualityTolerance(f);
  if (f.trailing_pe != null && f.trailing_pe > peLimit)
    flags.push(`stretched valuation (P/E ${f.trailing_pe.toFixed(0)})`);
  if (f.short_percent_float != null && f.short_percent_float > 0.1)
    flags.push(`heavily shorted (${(f.short_percent_float * 100).toFixed(0)}% of float)`);
  if (f.revenue_growth != null && f.revenue_growth < -0.1)
    flags.push(`revenue shrinking ${(f.revenue_growth * 100).toFixed(0)}%`);
  const d = daysBetween(asOf, f.next_earnings_date);
  if (d != null && d >= 0 && d <= 5) flags.push(`results due in ${d}d`);
  return flags;
}

/** Compact human summary used in the prompt cell and the decision audit. */
function summarise(f: Fundamentals, subs: FundamentalsSubscores): string {
  const bits: string[] = [];
  const tier = scaleTier(f.market_cap);
  if (tier) bits.push(`${tier}-cap`);
  if (f.trailing_pe != null) bits.push(`P/E ${f.trailing_pe.toFixed(1)}`);
  else if (f.forward_pe != null) bits.push(`fwd P/E ${f.forward_pe.toFixed(1)}`);
  if (f.profit_margin != null) bits.push(`net margin ${(f.profit_margin * 100).toFixed(1)}%`);
  if (f.revenue_growth != null) bits.push(`rev ${(f.revenue_growth * 100).toFixed(1)}%`);
  if (f.return_on_equity != null) bits.push(`ROE ${(f.return_on_equity * 100).toFixed(0)}%`);
  if (f.debt_to_equity != null) bits.push(`D/E ${(f.debt_to_equity / 100).toFixed(2)}x`);
  if (f.free_cashflow != null && f.market_cap)
    bits.push(`FCF yld ${((f.free_cashflow / f.market_cap) * 100).toFixed(1)}%`);
  if (subs.analysts != null && f.analyst_count)
    bits.push(`${f.analyst_count} analysts`);
  return bits.length ? bits.join(", ") : "financials disclosed but sparse";
}

export function scoreFundamentals(
  f: Fundamentals | null | undefined,
  asOf: string,
  symbol?: string,
): FundamentalsScore {
  if (!f) return EMPTY_FUNDAMENTALS_SCORE(symbol ?? "?");

  const subscores: FundamentalsSubscores = {
    valuation: scoreValuation(f),
    profitability: scoreProfitability(f),
    growth: scoreGrowth(f),
    balance_sheet: scoreBalanceSheet(f),
    shareholder: scoreShareholder(f),
    analysts: scoreAnalysts(f),
  };

  const pillars = Object.values(subscores);
  const coverage = pillars.filter((x) => x != null).length;
  const base = meanOf(pillars) ?? 0;

  const flags = financialFlags(f, asOf);
  // Hard risks bite: each one shaves the score, capped so flags alone cannot
  // drive a healthy company to maximally negative.
  const penalty = Math.min(0.5, flags.filter((x) => !x.startsWith("results due")).length * 0.12);
  // Size tilt: bigger, deeper names are cheaper to trade and have carried this
  // account's winners. Bounded to +/-0.08 so it only ever breaks ties.
  const size = scaleBonus(f.market_cap);

  return {
    symbol: f.symbol,
    score: Number(clamp1(base - penalty + size).toFixed(3)),
    subscores,
    coverage,
    flags,
    summary: summarise(f, subscores),
  };
}
