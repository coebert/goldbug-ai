// Deterministic financial-health gate for equity buys.
//
// The decision prompt already tells the model to read each company's published
// financials before buying. That is advice; this module is the enforcement.
// Every equity buy passes through here after the model has spoken, so a name
// with genuinely distressed accounts is downsized — or refused — regardless of
// how attractive the price action looked.
//
// Only *disclosed* company information is used: the scored accounts
// (`FundamentalsScore.score`), how much the company has disclosed
// (`coverage`) and the hard red flags derived from the reported numbers.
// Instruments with no accounts (ETFs, commodities, FX, crypto) are untouched.

import type { FundamentalsScore } from "./types";

/** Flags that describe an impaired business, not merely an expensive one. */
const DISTRESS = [
  "loss-making",
  "negative free cash flow",
  "high leverage",
  "weak liquidity",
  "dividend not covered",
  "revenue shrinking",
] as const;

/** Flags that argue for a smaller ticket rather than a refusal. */
const CAUTION = ["stretched valuation", "heavily shorted", "results due"] as const;

function countMatches(flags: string[], needles: readonly string[]): string[] {
  return flags.filter((f) => needles.some((n) => f.toLowerCase().startsWith(n)));
}

export type FundamentalsGateInput = {
  /** Scored published accounts, or null when the company discloses nothing. */
  score: FundamentalsScore | null;
  /** "stock" / "etf" / "commodity" / "fx" / "crypto". */
  assetClass: string | null | undefined;
  riskLevel?: "conservative" | "balanced" | "aggressive" | string | null;
};

export type FundamentalsGateResult = {
  /** Set when the buy must be refused outright. */
  block: string | null;
  /** Soft sizing multiplier in (0, 1]. */
  mult: number;
  /** Sizing-notes / audit line, or null when the accounts are unremarkable. */
  note: string | null;
  /** Distress flags that drove the decision. */
  distress: string[];
};

const PASS: FundamentalsGateResult = { block: null, mult: 1, note: null, distress: [] };

/** How many distress flags it takes to refuse a buy, by risk appetite. */
function blockThreshold(riskLevel: string | null | undefined): number {
  if (riskLevel === "conservative") return 2;
  if (riskLevel === "aggressive") return 4;
  return 3;
}

/**
 * Assess a candidate equity buy against its published financials.
 *
 * - Companies with several disclosed distress markers are blocked.
 * - A single distress marker, a deeply negative composite score or thin
 *   disclosure produces a haircut, never a hard stop.
 * - Non-equity instruments and unscored rows pass through unchanged.
 */
export function fundamentalsGate(input: FundamentalsGateInput): FundamentalsGateResult {
  const cls = (input.assetClass ?? "").toLowerCase();
  if (cls && cls !== "stock") return PASS;

  const s = input.score;
  if (!s) return PASS;

  // Nothing disclosed at all: unknown is not clean, but it is not distress
  // either — take a modest ticket.
  if (s.coverage <= 0) {
    return {
      block: null,
      mult: 0.75,
      note: "financials: nothing disclosed — size trimmed",
      distress: [],
    };
  }

  const distress = countMatches(s.flags, DISTRESS);
  const caution = countMatches(s.flags, CAUTION);
  const limit = blockThreshold(input.riskLevel);

  if (distress.length >= limit) {
    return {
      block: `published financials show ${distress.length} distress markers — ${distress.join("; ")}`,
      mult: 0,
      note: null,
      distress,
    };
  }

  // Deeply negative accounts with real disclosure behind them are a refusal
  // in their own right, even when the individual flags stay below the count.
  if (s.score <= -0.6 && s.coverage >= 4) {
    return {
      block: `published financials score ${s.score.toFixed(2)} on ${s.coverage}/6 disclosed pillars — ${s.summary}`,
      mult: 0,
      note: null,
      distress,
    };
  }

  const parts: string[] = [];
  let mult = 1;

  if (distress.length > 0) {
    mult *= distress.length === 1 ? 0.6 : 0.45;
    parts.push(distress.join("; "));
  }
  if (caution.length > 0) {
    mult *= caution.length === 1 ? 0.85 : 0.75;
    parts.push(caution.join("; "));
  }
  if (s.score < 0) {
    mult *= 1 + Math.max(-0.4, s.score * 0.4); // score -1 → ×0.60
    parts.push(`score ${s.score.toFixed(2)}`);
  } else if (s.score >= 0.5 && s.coverage >= 4 && distress.length === 0) {
    // Strong, well-disclosed accounts: no haircut, and say so in the trail.
    return {
      block: null,
      mult: 1,
      note: `financials strong ${s.score.toFixed(2)} (${s.coverage}/6)`,
      distress: [],
    };
  }
  if (s.coverage <= 2) {
    mult *= 0.85;
    parts.push(`thin disclosure ${s.coverage}/6`);
  }

  mult = Math.max(0.25, Math.min(1, mult));
  if (mult >= 0.999) return PASS;

  return {
    block: null,
    mult,
    note: `financials ×${mult.toFixed(2)} — ${parts.join(", ")}`,
    distress,
  };
}
