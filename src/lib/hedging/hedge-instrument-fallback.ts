// Gold tail-hedge instrument fallback.
//
// The tail hedge is proxied with a physically-backed gold ETC/ETF. A single
// hard-coded symbol is fragile: Saxo refuses SGLN.L on accounts without the
// ETC suitability/appropriateness test, and a missing quote for one listing
// silently drops the whole hedge. Both failures are instrument-specific, not
// strategy-specific — an equivalent gold wrapper hedges exactly the same risk.
//
// This module picks the first *eligible* candidate from a currency-ordered
// preference list. Eligibility is injected (known / priced / blocked / held)
// so the logic stays pure and testable, with no broker or universe imports.

/** Gold wrappers, ordered by home-venue preference. */
export const GOLD_HEDGE_CANDIDATES_GBP = ["SGLN.L", "SGLD.L", "PHAU.L", "GLD", "IAU"] as const;
export const GOLD_HEDGE_CANDIDATES_USD = ["GLD", "IAU", "SGLN.L", "SGLD.L", "PHAU.L"] as const;

/**
 * Candidate ladder for a portfolio currency, with `preferred` (an explicit
 * per-portfolio override) promoted to the front when supplied.
 */
export function hedgeCandidatesFor(
  currency: string,
  preferred?: string | null,
): string[] {
  const c = (currency || "GBP").toUpperCase();
  const base = c === "USD"
    ? [...GOLD_HEDGE_CANDIDATES_USD]
    : [...GOLD_HEDGE_CANDIDATES_GBP];
  const head = (preferred ?? "").trim();
  if (!head) return base;
  return [head, ...base.filter((s) => s.toUpperCase() !== head.toUpperCase())];
}

export type HedgeEligibility = {
  /** Symbol exists in the tradable universe. */
  isKnown: (symbol: string) => boolean;
  /** A usable live quote exists. */
  hasPrice: (symbol: string) => boolean;
  /** Broker refuses this instrument on this account. */
  isBlocked: (symbol: string) => boolean;
  /** Portfolio already holds a non-dust position. */
  isHeld: (symbol: string) => boolean;
};

export type HedgeSelection = {
  symbol: string | null;
  /** Set when the primary candidate was unusable and a substitute was chosen. */
  fallbackFrom: string | null;
  /** Human-readable note appended to the trade reason / decision log. */
  note: string;
  /** Per-candidate rejection reasons, for diagnostics. */
  rejected: Array<{ symbol: string; reason: string }>;
};

/**
 * Choose the hedge instrument for a side.
 *
 * BUY  — skip blocked, unknown, and unpriced candidates; prefer one already
 *        held so the hedge stays consolidated in a single line.
 * SELL — never blocked-gated (unwinding a position the broker refuses to *buy*
 *        must always stay possible); only held candidates can be unwound, and
 *        a missing quote is tolerated because the caller can size off cost
 *        basis.
 */
export function selectHedgeInstrument(input: {
  candidates: string[];
  side: "buy" | "sell";
  eligibility: HedgeEligibility;
}): HedgeSelection {
  const { candidates, side, eligibility } = input;
  const primary = candidates[0] ?? null;
  const rejected: Array<{ symbol: string; reason: string }> = [];

  const eligible: string[] = [];
  for (const symbol of candidates) {
    if (!eligibility.isKnown(symbol)) {
      rejected.push({ symbol, reason: "not in universe" });
      continue;
    }
    if (side === "sell") {
      if (!eligibility.isHeld(symbol)) {
        rejected.push({ symbol, reason: "nothing held to unwind" });
        continue;
      }
      eligible.push(symbol);
      continue;
    }
    if (eligibility.isBlocked(symbol)) {
      rejected.push({ symbol, reason: "broker block (suitability/permissions)" });
      continue;
    }
    if (!eligibility.hasPrice(symbol)) {
      rejected.push({ symbol, reason: "no live price" });
      continue;
    }
    eligible.push(symbol);
  }

  if (eligible.length === 0) {
    return {
      symbol: null,
      fallbackFrom: null,
      note: primary
        ? `no eligible gold hedge instrument (${rejected.map((r) => `${r.symbol}: ${r.reason}`).join("; ")})`
        : "no gold hedge candidates configured",
      rejected,
    };
  }

  // Consolidate onto an existing hedge line when one qualifies.
  const held = eligible.find((s) => eligibility.isHeld(s));
  const symbol = held ?? eligible[0]!;
  const isFallback = primary != null && symbol.toUpperCase() !== primary.toUpperCase();
  const why = rejected.find((r) => r.symbol.toUpperCase() === (primary ?? "").toUpperCase())?.reason;

  return {
    symbol,
    fallbackFrom: isFallback ? primary : null,
    note: isFallback
      ? ` [hedge fallback: ${primary} unusable (${why ?? "ineligible"}) → ${symbol}]`
      : "",
    rejected,
  };
}
