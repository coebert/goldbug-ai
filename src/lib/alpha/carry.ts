// Carry model.
//
// Phase 3 item 16 — real carry when the company publishes it, proxy carry
// when it does not.
//
// Preferred path: the published dividend yield from the accounts, measured as
// *excess* over the cash rate (holding a 3% payer when cash pays 4% is not
// carry), and quality-checked against the payout ratio — a yield only counts
// if earnings cover it. Yields far above the market are treated as distress
// signals, not free money, so the score rolls over rather than maxing out.
//
// Fallback path (ETFs, commodities, FX, crypto, uncovered names): the old
// price-derived proxy — carry-friendly asset class, ultra-low realised vol,
// gentle positive drift.
//
// Bounded and modest either way — carry is a tilt, not a primary driver.
import { clamp1, type AlphaScore, type FeatureLike } from "./types";

const CARRY_FRIENDLY = new Set(["bond", "credit", "yield", "dividend", "cash"]);

/** Default short-sterling cash rate used as the carry hurdle. */
export const DEFAULT_CASH_RATE = 0.04;

/** Excess yield (over cash) that earns the full positive score. */
const EXCESS_YIELD_FULL = 0.04;

/** Above this yield the payout is more likely a warning than a reward. */
const DISTRESS_YIELD = 0.1;

export type CarryOptions = {
  /** Risk-free / cash rate to clear before a yield counts as carry. */
  cashRate?: number;
};

function normaliseYield(raw: number): number {
  // Providers publish yield either as a fraction (0.043) or as a percent
  // (4.3). Anything above 1 is unambiguously the percent form.
  return raw > 1 ? raw / 100 : raw;
}

function normalisePayout(raw: number): number {
  return raw > 3 ? raw / 100 : raw;
}

function proxyCarry(f: FeatureLike): { score: number; notes: string[] } {
  const parts: number[] = [];
  const notes: string[] = [];

  const cls = (f.asset_class ?? "").toLowerCase();
  if (CARRY_FRIENDLY.has(cls)) {
    parts.push(0.4);
    notes.push(`${cls} carry-friendly`);
  }
  if (f.vol20d != null && f.vol20d < 0.01) {
    parts.push(0.6);
    notes.push("ultra-low vol");
  } else if (f.vol20d != null && f.vol20d < 0.02) {
    parts.push(0.3);
  } else {
    parts.push(-0.1);
  }
  if (f.change30d != null && f.change30d > 0 && f.change30d < 0.05) {
    parts.push(0.4);
    notes.push("gentle drift");
  }
  if (f.atr_pct != null && f.atr_pct < 0.01) parts.push(0.3);

  const score = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  return { score, notes };
}

export function scoreCarry(f: FeatureLike, opts: CarryOptions = {}): AlphaScore {
  const cashRate = opts.cashRate ?? DEFAULT_CASH_RATE;
  const fund = f.fundamentals ?? null;
  const rawYield = fund?.dividend_yield;

  if (rawYield != null && Number.isFinite(rawYield) && rawYield > 0) {
    const dy = normaliseYield(Number(rawYield));
    const excess = dy - cashRate;
    const notes: string[] = [`yield ${(dy * 100).toFixed(1)}% vs cash ${(cashRate * 100).toFixed(1)}%`];

    // Base: excess yield scaled, saturating at EXCESS_YIELD_FULL.
    let score = clamp1(excess / EXCESS_YIELD_FULL);

    // Distress taper: implausibly fat yields usually price a cut, not carry.
    if (dy >= DISTRESS_YIELD) {
      score = Math.min(score, 0.2) - 0.3;
      notes.push("yield in distress territory");
    }

    // Coverage check on the published payout ratio.
    const rawPayout = fund?.payout_ratio;
    if (rawPayout != null && Number.isFinite(rawPayout)) {
      const payout = normalisePayout(Number(rawPayout));
      if (payout > 1) {
        score = Math.min(score, 0) - 0.3;
        notes.push(`payout ${(payout * 100).toFixed(0)}% not covered by earnings`);
      } else if (payout > 0.8) {
        score *= 0.6;
        notes.push(`payout ${(payout * 100).toFixed(0)}% stretched`);
      } else if (payout > 0 && score > 0) {
        score = Math.min(1, score * 1.1);
        notes.push("payout comfortably covered");
      }
    }

    // Steady names carry better than jumpy ones; small, bounded nudge.
    if (f.vol20d != null && f.vol20d < 0.015 && score > 0) score = Math.min(1, score * 1.1);

    return {
      symbol: f.symbol,
      kind: "carry",
      score: clamp1(score),
      reason: notes.join(", "),
    };
  }

  const { score, notes } = proxyCarry(f);
  return {
    symbol: f.symbol,
    kind: "carry",
    score: clamp1(score),
    reason: notes.length ? `${notes.join(", ")} (proxy)` : "no carry edge",
  };
}
