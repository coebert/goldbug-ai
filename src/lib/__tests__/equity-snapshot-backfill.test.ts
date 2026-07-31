import { describe, expect, it } from "vitest";
import {
  markHoldingsToMarket,
  planMissingEquitySnapshots,
  type BackfillHolding,
} from "../equity-snapshot-backfill";

const TODAY = "2026-07-31";

const pf = (id: string, cash: number, inception: string | null = null) => ({
  id,
  current_cash: cash,
  inception,
});

describe("markHoldingsToMarket", () => {
  it("folds LSE pence quotes to GBP and leaves ETFs alone", () => {
    const holdings: BackfillHolding[] = [
      { portfolio_id: "p", symbol: "HSBA.L", quantity: 100, asset_class: "stock" },
      { portfolio_id: "p", symbol: "VUKE.L", quantity: 10, asset_class: "etf" },
    ];
    const prices = new Map([["HSBA.L", 900], ["VUKE.L", 35]]);
    expect(markHoldingsToMarket(holdings, prices)).toBe(900 + 350);
  });

  it("falls back to cost basis when a price is missing", () => {
    const holdings: BackfillHolding[] = [
      { portfolio_id: "p", symbol: "AAPL", quantity: 5, avg_cost: 200 },
    ];
    expect(markHoldingsToMarket(holdings, new Map())).toBe(1000);
  });
});

describe("planMissingEquitySnapshots", () => {
  it("writes today's mark-to-market row for a portfolio with no snapshots", () => {
    const planned = planMissingEquitySnapshots({
      portfolios: [pf("p1", 5000)],
      snapshots: [],
      holdings: [{ portfolio_id: "p1", symbol: "AAPL", quantity: 10, avg_cost: 100 }],
      prices: new Map([["AAPL", 150]]),
      today: TODAY,
    });
    expect(planned).toEqual([
      {
        portfolio_id: "p1",
        snapshot_date: TODAY,
        cash: 5000,
        holdings_value: 1500,
        total_value: 6500,
        reason: "today",
      },
    ]);
  });

  it("is idempotent when today's row is already correctly marked", () => {
    const planned = planMissingEquitySnapshots({
      portfolios: [pf("p1", 5000)],
      snapshots: [{
        portfolio_id: "p1",
        snapshot_date: TODAY,
        cash: 5000,
        holdings_value: 0,
        total_value: 5000,
      }],
      holdings: [],
      prices: new Map(),
      today: TODAY,
    });
    expect(planned).toEqual([]);
  });

  it("replaces a stale same-day cash-only row after holdings arrive", () => {
    const planned = planMissingEquitySnapshots({
      portfolios: [pf("balanced", 547_499.46)],
      snapshots: [{
        portfolio_id: "balanced",
        snapshot_date: TODAY,
        cash: 1_000_000,
        holdings_value: 0,
        total_value: 1_000_000,
      }],
      holdings: [
        { portfolio_id: "balanced", symbol: "JNJ", quantity: 636, avg_cost: 265.95 },
        { portfolio_id: "balanced", symbol: "V", quantity: 704, avg_cost: 362.53 },
      ],
      prices: new Map([["JNJ", 270], ["V", 365]]),
      today: TODAY,
    });

    expect(planned).toEqual([{
      portfolio_id: "balanced",
      snapshot_date: TODAY,
      cash: 547_499.46,
      holdings_value: 428_680,
      total_value: 976_179.46,
      reason: "today",
    }]);
  });

  it("carries the last known total forward across gap days", () => {
    const planned = planMissingEquitySnapshots({
      portfolios: [pf("p1", 1000)],
      snapshots: [
        { portfolio_id: "p1", snapshot_date: "2026-07-28", cash: 400, total_value: 1200 },
      ],
      holdings: [],
      prices: new Map(),
      today: TODAY,
    });
    expect(planned.filter((p) => p.reason === "carry_forward").map((p) => p.snapshot_date)).toEqual([
      "2026-07-29",
      "2026-07-30",
    ]);
    expect(planned.at(-1)).toMatchObject({ snapshot_date: TODAY, reason: "today" });
    const carried = planned[0];
    expect(carried.total_value).toBe(1200);
    expect(carried.cash + carried.holdings_value).toBe(1200);
  });

  it("caps carry-forward writes", () => {
    const planned = planMissingEquitySnapshots({
      portfolios: [pf("p1", 100)],
      snapshots: [
        { portfolio_id: "p1", snapshot_date: "2025-01-01", cash: 100, total_value: 100 },
      ],
      holdings: [],
      prices: new Map(),
      today: TODAY,
      maxCarryForwardDays: 5,
    });
    expect(planned.filter((p) => p.reason === "carry_forward")).toHaveLength(5);
  });

  it("never writes rows before inception", () => {
    const planned = planMissingEquitySnapshots({
      portfolios: [pf("p1", 100, "2026-07-30")],
      snapshots: [
        { portfolio_id: "p1", snapshot_date: "2026-07-20", cash: 100, total_value: 100 },
      ],
      holdings: [],
      prices: new Map(),
      today: TODAY,
    });
    expect(planned.every((p) => p.snapshot_date >= "2026-07-30")).toBe(true);
  });

  it("skips an all-zero row for an empty, unfunded portfolio", () => {
    const planned = planMissingEquitySnapshots({
      portfolios: [pf("p1", 0)],
      snapshots: [],
      holdings: [],
      prices: new Map(),
      today: TODAY,
    });
    expect(planned).toEqual([]);
  });

  it("keeps portfolios independent", () => {
    const planned = planMissingEquitySnapshots({
      portfolios: [pf("p1", 1000), pf("p2", 2000)],
      snapshots: [{ portfolio_id: "p1", snapshot_date: TODAY, total_value: 1000 }],
      holdings: [{ portfolio_id: "p2", symbol: "MSFT", quantity: 2, avg_cost: 300 }],
      prices: new Map([["MSFT", 400]]),
      today: TODAY,
    });
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ portfolio_id: "p2", total_value: 2800 });
  });
});
