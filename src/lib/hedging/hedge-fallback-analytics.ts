// Hedge instrument-fallback analytics (pure).
//
// The tail-hedge executor records its chosen instrument and, when the primary
// candidate was unusable, appends a note of the form
//
//   [hedge fallback: SGLN.L unusable (broker block (suitability/permissions)) → SGLD.L]
//
// to the trade reason persisted in `decisions.raw.tail_hedge_execution`.
// This module parses those notes and rolls them up by currency, instrument
// pair, and eventual outcome so a dashboard can answer: when the primary gold
// hedge is refused, does the substitute actually get the hedge on?
//
// "Later succeeded" is deliberately forward-looking: the run in which the
// substitution happened may only route the order (live portfolios don't mutate
// the local mirror), so we look at the observed hedge notional on the SAME
// portfolio in subsequent runs and compare it against the advised target.

/** Fraction of the advised target that counts as the hedge being on. */
export const HEDGE_ESTABLISHED_RATIO = 0.8;

export type ParsedFallback = { from: string; to: string; why: string };

const FALLBACK_RE =
  /\[hedge fallback:\s*([^\s]+)\s+unusable\s*\(([^)]*)\)\s*(?:→|->)\s*([^\]]+)\]/i;

/** Extract the substitution recorded in a hedge trade reason, if any. */
export function parseHedgeFallbackNote(reason: string | null | undefined): ParsedFallback | null {
  if (!reason) return null;
  const m = FALLBACK_RE.exec(reason);
  if (!m) return null;
  const from = (m[1] ?? "").trim();
  const to = (m[3] ?? "").trim();
  if (!from || !to) return null;
  return { from, to, why: (m[2] ?? "ineligible").trim() };
}

/** One tail-hedge run record, flattened out of `decisions.raw`. */
export type HedgeRunRecord = {
  decisionId: string;
  runDate: string; // YYYY-MM-DD
  portfolioId: string;
  portfolioName: string;
  currency: string;
  /** Instrument the executor actually used (may be the substitute). */
  symbol: string | null;
  side: "buy" | "sell" | "hold" | "none";
  applied: boolean;
  reason: string | null;
  /** Notional the executor booked on this run (0 for live pre-broker). */
  appliedNotional: number;
  /** Advisory target hedge notional for the run. */
  targetNotional: number;
  /** Hedge notional observed on the portfolio at run time. */
  observedNotional: number;
  slippageKind: "none" | "partial" | "unfilled" | "over" | null;
  deferralReason: string | null;
};

export type HedgeOutcome = "established" | "partial" | "failed" | "pending";

export type FallbackEvent = {
  decisionId: string;
  runDate: string;
  portfolioId: string;
  portfolioName: string;
  currency: string;
  from: string;
  to: string;
  why: string;
  side: "buy" | "sell" | "hold" | "none";
  applied: boolean;
  appliedNotional: number;
  targetNotional: number;
  observedNotional: number;
  slippageKind: HedgeRunRecord["slippageKind"];
  deferralReason: string | null;
  /** Did the hedge actually get on, at this run or a later one? */
  outcome: HedgeOutcome;
  /** Run date at which the hedge was first seen established (if any). */
  succeededOn: string | null;
  /** Best observed hedge notional at/after this run. */
  bestObservedNotional: number;
};

export type FallbackGroup = {
  key: string;
  label: string;
  events: number;
  established: number;
  partial: number;
  failed: number;
  pending: number;
  /** established / (events − pending), 0..1; null when nothing resolved yet. */
  successRate: number | null;
  substitutedNotional: number;
  lastRunDate: string | null;
};

export type HedgeFallbackSummary = {
  events: FallbackEvent[];
  byCurrency: FallbackGroup[];
  byPair: FallbackGroup[];
  totals: {
    events: number;
    established: number;
    partial: number;
    failed: number;
    pending: number;
    successRate: number | null;
    substitutedNotional: number;
    distinctPairs: number;
  };
};

function outcomeOf(
  record: HedgeRunRecord,
  bestObserved: number,
  hasLaterRun: boolean,
): { outcome: HedgeOutcome; established: boolean } {
  const target = Math.abs(record.targetNotional);
  // Unwinds are judged by the executor's own application: a sell that ran is
  // a success; there is no "target to reach" beyond the trim itself.
  if (record.side === "sell") {
    return record.applied
      ? { outcome: "established", established: true }
      : { outcome: "failed", established: false };
  }
  if (target <= 0) {
    return record.applied
      ? { outcome: "established", established: true }
      : { outcome: "pending", established: false };
  }
  const ratio = bestObserved / target;
  if (ratio >= HEDGE_ESTABLISHED_RATIO) return { outcome: "established", established: true };
  if (bestObserved > 0 || record.appliedNotional > 0)
    return { outcome: "partial", established: false };
  // Nothing on the book yet. Only call it a failure once a later run has had
  // the chance to show the broker fill.
  return hasLaterRun
    ? { outcome: "failed", established: false }
    : { outcome: "pending", established: false };
}

function emptyGroup(key: string, label: string): FallbackGroup {
  return {
    key,
    label,
    events: 0,
    established: 0,
    partial: 0,
    failed: 0,
    pending: 0,
    successRate: null,
    substitutedNotional: 0,
    lastRunDate: null,
  };
}

function pushGroup(map: Map<string, FallbackGroup>, key: string, label: string, e: FallbackEvent) {
  const g = map.get(key) ?? emptyGroup(key, label);
  g.events += 1;
  g[e.outcome] += 1;
  g.substitutedNotional += Math.abs(e.appliedNotional || e.targetNotional || 0);
  if (!g.lastRunDate || e.runDate > g.lastRunDate) g.lastRunDate = e.runDate;
  map.set(key, g);
}

function finalize(map: Map<string, FallbackGroup>): FallbackGroup[] {
  return [...map.values()]
    .map((g) => {
      const resolved = g.events - g.pending;
      return { ...g, successRate: resolved > 0 ? g.established / resolved : null };
    })
    .sort((a, b) => b.events - a.events || a.label.localeCompare(b.label));
}

/**
 * Roll tail-hedge run records up into a fallback summary.
 *
 * Records may arrive in any order; the forward-looking outcome check sorts
 * per portfolio by run date internally.
 */
export function buildHedgeFallbackSummary(records: HedgeRunRecord[]): HedgeFallbackSummary {
  const byPortfolio = new Map<string, HedgeRunRecord[]>();
  for (const r of records) {
    const list = byPortfolio.get(r.portfolioId) ?? [];
    list.push(r);
    byPortfolio.set(r.portfolioId, list);
  }
  for (const list of byPortfolio.values()) {
    list.sort((a, b) => a.runDate.localeCompare(b.runDate));
  }

  const events: FallbackEvent[] = [];

  for (const list of byPortfolio.values()) {
    list.forEach((record, idx) => {
      const parsed = parseHedgeFallbackNote(record.reason);
      if (!parsed) return;

      // Look forward on the same portfolio for the substitute actually
      // showing up on the book.
      let bestObserved = Math.max(record.observedNotional, record.appliedNotional);
      let succeededOn: string | null = null;
      const target = Math.abs(record.targetNotional);
      if (target > 0 && bestObserved / target >= HEDGE_ESTABLISHED_RATIO) {
        succeededOn = record.runDate;
      }
      for (let j = idx + 1; j < list.length; j += 1) {
        const later = list[j]!;
        if (later.observedNotional > bestObserved) bestObserved = later.observedNotional;
        if (!succeededOn && target > 0 && later.observedNotional / target >= HEDGE_ESTABLISHED_RATIO) {
          succeededOn = later.runDate;
        }
      }

      const { outcome } = outcomeOf(record, bestObserved, idx < list.length - 1);

      events.push({
        decisionId: record.decisionId,
        runDate: record.runDate,
        portfolioId: record.portfolioId,
        portfolioName: record.portfolioName,
        currency: (record.currency || "GBP").toUpperCase(),
        from: parsed.from,
        to: parsed.to,
        why: parsed.why,
        side: record.side,
        applied: record.applied,
        appliedNotional: record.appliedNotional,
        targetNotional: record.targetNotional,
        observedNotional: record.observedNotional,
        slippageKind: record.slippageKind,
        deferralReason: record.deferralReason,
        outcome,
        succeededOn: outcome === "established" ? (succeededOn ?? record.runDate) : null,
        bestObservedNotional: bestObserved,
      });
    });
  }

  events.sort((a, b) => b.runDate.localeCompare(a.runDate) || a.from.localeCompare(b.from));

  const ccy = new Map<string, FallbackGroup>();
  const pair = new Map<string, FallbackGroup>();
  for (const e of events) {
    pushGroup(ccy, e.currency, e.currency, e);
    const pk = `${e.from.toUpperCase()}→${e.to.toUpperCase()}`;
    pushGroup(pair, pk, pk, e);
  }

  const totals = events.reduce(
    (acc, e) => {
      acc.events += 1;
      acc[e.outcome] += 1;
      acc.substitutedNotional += Math.abs(e.appliedNotional || e.targetNotional || 0);
      return acc;
    },
    {
      events: 0,
      established: 0,
      partial: 0,
      failed: 0,
      pending: 0,
      substitutedNotional: 0,
    },
  );
  const resolved = totals.events - totals.pending;

  return {
    events,
    byCurrency: finalize(ccy),
    byPair: finalize(pair),
    totals: {
      ...totals,
      successRate: resolved > 0 ? totals.established / resolved : null,
      distinctPairs: pair.size,
    },
  };
}
