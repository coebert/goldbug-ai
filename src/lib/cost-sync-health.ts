// Pure grading of a broker charge-report ingest pass.
//
// The friction KPI is only as honest as the invoice tape behind it. When the
// Saxo cost report errors out, or comes back covering only a slice of the
// fills we hold, the KPI quietly degrades to modelled costs — which is
// exactly when we want to be told rather than left reading a plausible-looking
// number. This module owns the thresholds so the notifier, the banner and the
// tests all grade the same way.

export type CostSyncStatus = "ok" | "partial" | "failed";

export type CostSyncInput = {
  /** False when the adapter has no cost report, or the fetch threw. */
  supported: boolean;
  fillsConsidered: number;
  fillsUpdated: number;
  /** Fills left on modelled costs after this pass (excludes too-recent ones). */
  unmatchedFills: number;
  /** Set when the fetch itself threw. */
  error?: string | null;
  reason?: string | null;
};

export type CostSyncHealth = {
  status: CostSyncStatus;
  severity: "info" | "warning" | "critical";
  /** 0..1 share of considered fills that ended up broker-priced. */
  coverage: number;
  coveragePct: number;
  title: string;
  body: string;
  shouldAlert: boolean;
};

/**
 * Below this share of fills carrying a booked charge, the KPI is mostly
 * grading our own model, so the run counts as partial coverage. Deliberately
 * generous: brokers publish charges on a lag, and `unmatchedFills` already
 * excludes fills inside the publication grace window.
 */
export const COVERAGE_TARGET = 0.8;

export function evaluateCostSyncHealth(input: CostSyncInput): CostSyncHealth {
  const considered = Math.max(0, Math.trunc(input.fillsConsidered));
  const updated = Math.max(0, Math.trunc(input.fillsUpdated));
  const gap = Math.max(0, Math.trunc(input.unmatchedFills));
  const priced = Math.min(considered, updated);
  // With nothing to price, there is nothing to grade — treat as healthy so a
  // quiet week doesn't raise a false alarm.
  const coverage = considered === 0 ? 1 : priced / considered;
  const coveragePct = Math.round(coverage * 1000) / 10;

  if (!input.supported || input.error) {
    const why = input.error ?? input.reason ?? "the broker returned no cost report";
    return {
      status: "failed",
      severity: "critical",
      coverage: 0,
      coveragePct: 0,
      title: "Broker charge report unavailable",
      body:
        `The hourly run could not fetch Saxo's cost report (${why}). ` +
        `Trading costs are falling back to modelled estimates, so the friction figure is a projection, not the invoice.`,
      shouldAlert: true,
    };
  }

  if (considered > 0 && gap > 0 && coverage < COVERAGE_TARGET) {
    return {
      status: "partial",
      severity: "warning",
      coverage,
      coveragePct,
      title: "Broker charges only partially synced",
      body:
        `Saxo's cost report covered ${priced} of ${considered} recent fills (${coveragePct}%). ` +
        `${gap} fill${gap === 1 ? "" : "s"} past the publication window still have no booked charge, so friction for those trades is modelled rather than invoiced.`,
      shouldAlert: true,
    };
  }

  return {
    status: "ok",
    severity: "info",
    coverage,
    coveragePct,
    title: "Broker charges synced",
    body: `${priced} of ${considered} recent fills carry booked broker charges (${coveragePct}%).`,
    shouldAlert: false,
  };
}
