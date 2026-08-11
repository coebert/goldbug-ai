/**
 * Shaping for the broker-charge backfill. Pure: results in, summary out.
 *
 * Kept separate from the server module so the summary the UI reads — how many
 * fills the sync actually invoiced, and what share of the tape is now real
 * money rather than modelled cost — can be tested without a broker or a DB.
 */

import type { CostIngestResult } from "./broker-cost-ingest.server";

export type CostBackfillPortfolio = {
  portfolioId: string;
  name: string;
  mode: string;
  /** Fills in the window before the sync ran. */
  fillsConsidered: number;
  /** Fills carrying broker-booked charges before the sync. */
  invoicedBefore: number;
  /** Fills the sync wrote broker charges onto. */
  fillsUpdated: number;
  /** Fills carrying broker-booked charges after the sync. */
  invoicedAfter: number;
  /** Coverage after the sync, 0..1. */
  coverage: number;
  chargesFetched: number;
  unmatchedCharges: number;
  chargedTotal: number;
  currency: string;
  /** Null when the sync ran; a human reason when it could not. */
  skipped: string | null;
};

export type CostBackfillSummary = {
  lookbackDays: number;
  portfolios: CostBackfillPortfolio[];
  totals: {
    fillsConsidered: number;
    invoicedBefore: number;
    fillsUpdated: number;
    invoicedAfter: number;
    /** Share of all considered fills now invoiced, 0..1. */
    coverage: number;
    chargesFetched: number;
    unmatchedCharges: number;
  };
  /** Plain-English read for the card. */
  message: string;
  ranAt: string;
};

/**
 * `invoicedAfter` is counted, not inferred from `fillsUpdated`: a rerun
 * re-matches rows that were already invoiced, so adding the two would report
 * more covered fills than exist and push coverage above 1.
 */
export function summarisePortfolioBackfill(args: {
  portfolioId: string;
  name: string;
  mode: string;
  invoicedBefore: number;
  invoicedAfter: number;
  result: CostIngestResult | null;
  skipped?: string | null;
}): CostBackfillPortfolio {
  const r = args.result;
  const considered = r?.fillsConsidered ?? 0;
  return {
    portfolioId: args.portfolioId,
    name: args.name,
    mode: args.mode,
    fillsConsidered: considered,
    invoicedBefore: args.invoicedBefore,
    fillsUpdated: r?.fillsUpdated ?? 0,
    invoicedAfter: args.invoicedAfter,
    coverage: considered > 0 ? Math.min(1, args.invoicedAfter / considered) : 0,
    chargesFetched: r?.chargesFetched ?? 0,
    unmatchedCharges: r?.unmatchedCharges ?? 0,
    chargedTotal: r?.chargedTotal ?? 0,
    currency: r?.currency ?? "GBP",
    skipped: args.skipped ?? (r && !r.supported ? (r.reason ?? "broker cost report unavailable") : null),
  };
}

export function summariseBackfill(args: {
  portfolios: readonly CostBackfillPortfolio[];
  lookbackDays: number;
  ranAt?: string;
}): CostBackfillSummary {
  const t = {
    fillsConsidered: 0,
    invoicedBefore: 0,
    fillsUpdated: 0,
    invoicedAfter: 0,
    coverage: 0,
    chargesFetched: 0,
    unmatchedCharges: 0,
  };
  for (const p of args.portfolios) {
    t.fillsConsidered += p.fillsConsidered;
    t.invoicedBefore += p.invoicedBefore;
    t.fillsUpdated += p.fillsUpdated;
    t.invoicedAfter += p.invoicedAfter;
    t.chargesFetched += p.chargesFetched;
    t.unmatchedCharges += p.unmatchedCharges;
  }
  t.coverage = t.fillsConsidered > 0 ? Math.min(1, t.invoicedAfter / t.fillsConsidered) : 0;

  const skipped = args.portfolios.filter((p) => p.skipped);
  let message: string;
  if (t.fillsConsidered === 0) {
    message = `No trades in the last ${args.lookbackDays} days to price.`;
  } else if (t.fillsUpdated === 0 && t.invoicedAfter === 0) {
    message =
      skipped.length > 0
        ? `Your broker returned no charges: ${skipped[0]!.skipped}`
        : `Your broker has not published charges for these ${t.fillsConsidered} trades yet.`;
  } else {
    message =
      `Matched real broker charges to ${t.invoicedAfter} of ${t.fillsConsidered} trades ` +
      `(${Math.round(t.coverage * 100)}% of the last ${args.lookbackDays} days).` +
      (t.unmatchedCharges > 0
        ? ` ${t.unmatchedCharges} charge${t.unmatchedCharges === 1 ? "" : "s"} belonged to no trade we hold.`
        : "");
  }

  return {
    lookbackDays: args.lookbackDays,
    portfolios: [...args.portfolios],
    totals: t,
    message,
    ranAt: args.ranAt ?? new Date().toISOString(),
  };
}
