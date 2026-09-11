// Portfolio-level sector / correlation-cluster exposure budget.
//
// The only concentration control in the stack was a per-name position cap and
// a flat "at most 5 concurrent signals". Neither stops the book from holding
// five UK banks, or a breakout basket that is really one factor bet wearing
// five tickers. Correlated names fail together, and per-position ATR stops do
// not help when every stop triggers on the same day.
//
// This module answers one question for the executor: given what we already
// hold, how much more of this sector can we buy? It is pure — the caller
// resolves NAV, existing exposure by sector and the sector of each candidate.

export type SectorBudgetConfig = {
  navBase: number;
  /** Max gross exposure to any one sector, as a fraction of NAV. */
  maxSectorPctOfNav: number;
  /** Max gross exposure to symbols with no known sector, as a fraction of NAV. */
  maxUnknownPctOfNav: number;
};

export type SectorCandidate = {
  symbol: string;
  sector: string | null;
  notionalBase: number;
  /**
   * Broad, physically diversified index funds (VWRL, VUSA, ISF…). They span
   * every sector by construction, so the sector budget does not apply — the
   * per-name position cap governs them instead. Without this a global tracker
   * lands in the "unclassified" bucket and is capped at 15% of NAV, which
   * silently blocks the core allocation on every run.
   */
  diversified?: boolean;
  /** Conviction in [0,1] (|unifiedScore|) for the cap-stretch test. */
  edgeScore?: number;
  /** Expected favourable move as a fraction of notional. */
  expectedMovePct?: number;
  /** Estimated round-trip friction for this ticket, base currency. */
  estCostBase?: number;
};

export type SectorDecision =
  | { kind: "admit"; candidate: SectorCandidate }
  | { kind: "skip"; candidate: SectorCandidate; reason: string };

export type SectorPlan = {
  decisions: SectorDecision[];
  /** Post-admission exposure per sector key, base currency. */
  exposureAfter: Record<string, number>;
};

export const DEFAULT_SECTOR_BUDGET: Omit<SectorBudgetConfig, "navBase"> = {
  // A quarter of the book in one sector is already an aggressive factor bet
  // for a long-only, cash-funded account.
  maxSectorPctOfNav: 0.25,
  // Unclassified names get a tighter leash: we cannot reason about what they
  // are correlated with.
  maxUnknownPctOfNav: 0.15,
};

const UNKNOWN = "__unknown__";
const DIVERSIFIED = "__diversified__";

function keyFor(sector: string | null): string {
  const s = (sector ?? "").trim().toLowerCase();
  return s.length > 0 ? s : UNKNOWN;
}

/**
 * Admit buy candidates while each sector stays inside its share of NAV.
 * Candidates are considered largest-first so one oversized ticket cannot be
 * blocked by a queue of small ones that collectively fill the budget.
 * Existing exposure is counted, so this governs the *resulting* portfolio.
 */
export function planSectorAdmissions(
  candidates: SectorCandidate[],
  existingExposureBase: Record<string, number>,
  cfg: SectorBudgetConfig,
): SectorPlan {
  const nav = Math.max(0, cfg.navBase);
  const exposure: Record<string, number> = {};
  for (const [k, v] of Object.entries(existingExposureBase)) {
    exposure[keyFor(k)] = (exposure[keyFor(k)] ?? 0) + Math.max(0, Number(v) || 0);
  }

  const capFor = (key: string) =>
    nav * (key === UNKNOWN ? cfg.maxUnknownPctOfNav : cfg.maxSectorPctOfNav);

  const decisions: SectorDecision[] = [];
  const ordered = candidates.slice().sort((a, b) => b.notionalBase - a.notionalBase);

  for (const c of ordered) {
    if (c.diversified) {
      exposure[DIVERSIFIED] = (exposure[DIVERSIFIED] ?? 0) + Math.max(0, c.notionalBase);
      decisions.push({ kind: "admit", candidate: c });
      continue;
    }
    const key = keyFor(c.sector);
    const cap = capFor(key);
    const current = exposure[key] ?? 0;
    const after = current + Math.max(0, c.notionalBase);
    if (nav > 0 && after > cap) {
      decisions.push({
        kind: "skip",
        candidate: c,
        reason:
          `sector budget: ${key === UNKNOWN ? "unclassified" : key} exposure would reach ` +
          `${after.toFixed(0)} of a ${cap.toFixed(0)} cap ` +
          `(${((key === UNKNOWN ? cfg.maxUnknownPctOfNav : cfg.maxSectorPctOfNav) * 100).toFixed(0)}% of NAV ${nav.toFixed(0)}); ` +
          `already holding ${current.toFixed(0)}`,
      });
      continue;
    }
    exposure[key] = after;
    decisions.push({ kind: "admit", candidate: c });
  }

  return { decisions, exposureAfter: exposure };
}
