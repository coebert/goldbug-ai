import { describe, expect, it } from "vitest";
import {
  summariseBackfill,
  summarisePortfolioBackfill,
} from "../broker-cost-backfill";
import type { CostIngestResult } from "../broker-cost-ingest.server";

function result(over: Partial<CostIngestResult> = {}): CostIngestResult {
  return {
    supported: true,
    fillsConsidered: 40,
    chargesFetched: 42,
    fillsUpdated: 40,
    unmatchedCharges: 2,
    unmatchedFills: 0,
    unitMismatches: 0,
    chargedTotal: 123.45,
    currency: "GBP",
    ...over,
  };
}

describe("summarisePortfolioBackfill", () => {
  it("reports counted coverage, not updated + before", () => {
    // Rerun: every fill was already invoiced and gets re-matched.
    const p = summarisePortfolioBackfill({
      portfolioId: "p1",
      name: "My Portfolio",
      mode: "live_prod",
      invoicedBefore: 40,
      invoicedAfter: 40,
      result: result(),
    });
    expect(p.coverage).toBe(1);
    expect(p.fillsUpdated).toBe(40);
    expect(p.skipped).toBeNull();
  });

  it("carries the broker's reason when the report is unsupported", () => {
    const p = summarisePortfolioBackfill({
      portfolioId: "p1",
      name: "My Portfolio",
      mode: "live_prod",
      invoicedBefore: 0,
      invoicedAfter: 0,
      result: result({ supported: false, fillsUpdated: 0, reason: "no cost endpoint" }),
    });
    expect(p.skipped).toBe("no cost endpoint");
    expect(p.coverage).toBe(0);
  });

  it("marks simulated ledgers as skipped with zero fills", () => {
    const p = summarisePortfolioBackfill({
      portfolioId: "p2",
      name: "Paper",
      mode: "paper",
      invoicedBefore: 0,
      invoicedAfter: 0,
      result: null,
      skipped: "portfolio is not linked to a broker (simulated ledger)",
    });
    expect(p.fillsConsidered).toBe(0);
    expect(p.skipped).toMatch(/simulated ledger/);
  });
});

describe("summariseBackfill", () => {
  const rows = [
    summarisePortfolioBackfill({
      portfolioId: "p1",
      name: "My Portfolio",
      mode: "live_prod",
      invoicedBefore: 0,
      invoicedAfter: 38,
      result: result({ fillsConsidered: 40, fillsUpdated: 38, unmatchedCharges: 2 }),
    }),
    summarisePortfolioBackfill({
      portfolioId: "p2",
      name: "Balanced risk sim",
      mode: "live_sim",
      invoicedBefore: 0,
      invoicedAfter: 15,
      result: result({ fillsConsidered: 15, fillsUpdated: 15, unmatchedCharges: 0, chargesFetched: 15 }),
    }),
    summarisePortfolioBackfill({
      portfolioId: "p3",
      name: "High risk sim portfolio",
      mode: "live_sim",
      invoicedBefore: 0,
      invoicedAfter: 12,
      result: result({ fillsConsidered: 12, fillsUpdated: 12, unmatchedCharges: 0, chargesFetched: 12 }),
    }),
  ];

  it("totals the 67-fill tape and reports coverage as a share of it", () => {
    const s = summariseBackfill({ portfolios: rows, lookbackDays: 45 });
    expect(s.totals.fillsConsidered).toBe(67);
    expect(s.totals.invoicedAfter).toBe(65);
    expect(s.totals.coverage).toBeCloseTo(65 / 67, 10);
    expect(s.message).toContain("65 of 67");
    expect(s.message).toContain("2 charges belonged to no trade");
  });

  it("never lets coverage exceed 1 on a rerun", () => {
    const s = summariseBackfill({
      portfolios: [
        summarisePortfolioBackfill({
          portfolioId: "p1",
          name: "x",
          mode: "live_prod",
          invoicedBefore: 40,
          invoicedAfter: 44,
          result: result({ fillsConsidered: 40, fillsUpdated: 40 }),
        }),
      ],
      lookbackDays: 45,
    });
    expect(s.totals.coverage).toBe(1);
  });

  it("explains a broker that published nothing", () => {
    const s = summariseBackfill({
      portfolios: [
        summarisePortfolioBackfill({
          portfolioId: "p1",
          name: "x",
          mode: "live_prod",
          invoicedBefore: 0,
          invoicedAfter: 0,
          result: result({ supported: false, fillsUpdated: 0, reason: "no cost endpoint" }),
        }),
      ],
      lookbackDays: 45,
    });
    expect(s.message).toContain("no cost endpoint");
  });

  it("says so when there is nothing in the window", () => {
    const s = summariseBackfill({ portfolios: [], lookbackDays: 45 });
    expect(s.message).toMatch(/No trades in the last 45 days/);
    expect(s.totals.coverage).toBe(0);
  });
});
