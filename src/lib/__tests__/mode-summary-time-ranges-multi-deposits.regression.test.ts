// Regression: % change calculation must stay correct across different
// time-range window slices (7d / 30d / 90d / YTD / ALL) AND across
// multiple deposit and withdrawal events scattered inside the window.
//
// computeModeSummary anchors `previous` to the second-to-last row and
// `last` to the last row of the series it receives. Callers that offer
// range pickers therefore feed it a two-row series: [windowStart,
// windowEnd]. Deposits strictly AFTER windowStart.date up to & including
// windowEnd.date are netted out of pnl/pct, so any number of cash-flow
// events collapse to their sum and pure cash-flow contributes 0.
//
// Guards:
//   - The same trading PnL produces the same pnl regardless of how many
//     deposits/withdrawals sit inside the window.
//   - Denominator stays anchored to pre-window equity, so pct scales
//     only with window trading PnL.
//   - Deposits dated on/before windowStart are NOT re-netted.
//   - Deposit dated exactly on windowEnd IS netted (inclusive right).
//   - Deposit dated exactly on windowStart is NOT netted (exclusive left).
//   - Withdrawals net symmetrically.

import { describe, expect, it } from "vitest";
import {
  computeModeSummary,
  type DepositEvent,
  type SummaryPortfolio,
  type SummarySeriesRow,
} from "@/lib/mode-summary";

const LIVE: SummaryPortfolio = { id: "live-1", mode: "live_prod" };

// Helper: build a two-row window series [start, end] where `end` equals
// `start + tradingPnl + sum(inWindowFlows)`. This mirrors what a
// time-range picker passes to computeModeSummary.
const windowRows = (
  startDate: string,
  startEquity: number,
  endDate: string,
  tradingPnl: number,
  inWindowFlows: number,
): SummarySeriesRow[] => [
  { date: startDate, "live-1": startEquity },
  { date: endDate, "live-1": startEquity + tradingPnl + inWindowFlows },
];

describe("computeModeSummary — % change across time ranges & multi-deposit events", () => {
  it("7-day window with a single mid-window deposit → deposit netted, pnl == trading only", () => {
    // start £1,000 → end £1,105: +£100 deposit on day 3, +£5 trading.
    const rows = windowRows("2026-06-01", 1_000, "2026-06-07", 5, 100);
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-06-03", amount: 100 },
    ];
    const s = computeModeSummary(rows, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(5, 10);
    expect(s?.real.pct).toBeCloseTo((5 / 1_000) * 100, 10);
  });

  it("30-day window with three deposits + one withdrawal → all netted, pnl == £30", () => {
    // Flows: +200, +500, +50, -100 = +£650 net cash-flow.
    // Trading PnL = £30 → end equity = 1000 + 650 + 30 = 1680.
    const rows = windowRows("2026-06-01", 1_000, "2026-06-30", 30, 650);
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-06-05", amount: 200 },
      { portfolio_id: "live-1", date: "2026-06-12", amount: 500 },
      { portfolio_id: "live-1", date: "2026-06-20", amount: -100 },
      { portfolio_id: "live-1", date: "2026-06-28", amount: 50 },
    ];
    const s = computeModeSummary(rows, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(30, 10);
    expect(s?.real.pct).toBeCloseTo((30 / 1_000) * 100, 10);
  });

  it("90-day (quarter) window with 5 deposits → pnl == pure trading PnL, £89", () => {
    // Five deposits totalling £1,650 over 90 days, plus £89 trading PnL.
    const rows = windowRows("2026-05-01", 1_000, "2026-07-29", 89, 1_650);
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-05-06", amount: 200 },
      { portfolio_id: "live-1", date: "2026-05-21", amount: 500 },
      { portfolio_id: "live-1", date: "2026-06-15", amount: -100 },
      { portfolio_id: "live-1", date: "2026-06-30", amount: 1_000 },
      { portfolio_id: "live-1", date: "2026-07-20", amount: 50 },
    ];
    const s = computeModeSummary(rows, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(89, 10);
    expect(s?.real.pct).toBeCloseTo((89 / 1_000) * 100, 10);
  });

  it("pnl is invariant to the NUMBER of deposit events (same net cash-flow)", () => {
    // Same £500 net inflow, same £20 trading PnL → same pnl and pct
    // whether it arrives as 1, 5, or 20 discrete events.
    const oneEvent: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-06-10", amount: 500 },
    ];
    const fiveEvents: DepositEvent[] = Array.from({ length: 5 }, (_, i) => ({
      portfolio_id: "live-1",
      date: `2026-06-${String(5 + i * 2).padStart(2, "0")}`,
      amount: 100,
    }));
    const twentyEvents: DepositEvent[] = Array.from({ length: 20 }, (_, i) => ({
      portfolio_id: "live-1",
      date: `2026-06-${String(2 + i).padStart(2, "0")}`,
      amount: 25,
    }));
    const rows = windowRows("2026-06-01", 1_000, "2026-06-30", 20, 500);
    for (const deposits of [oneEvent, fiveEvents, twentyEvents]) {
      const s = computeModeSummary(rows, [LIVE], deposits);
      expect(s?.real.pnl).toBeCloseTo(20, 10);
      expect(s?.real.pct).toBeCloseTo((20 / 1_000) * 100, 10);
    }
  });

  it("pct scales linearly with trading PnL when the anchor equity is fixed", () => {
    // Same £1,000 anchor + same deposit set. Vary trading PnL only.
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-06-05", amount: 200 },
      { portfolio_id: "live-1", date: "2026-06-15", amount: 300 },
    ];
    for (const trading of [0, 10, 50, 250, -75]) {
      const rows = windowRows("2026-06-01", 1_000, "2026-06-30", trading, 500);
      const s = computeModeSummary(rows, [LIVE], deposits);
      expect(s?.real.pnl).toBeCloseTo(trading, 10);
      expect(s?.real.pct).toBeCloseTo((trading / 1_000) * 100, 10);
    }
  });

  it("deposit dated on/before windowStart is NOT re-netted (no double-count)", () => {
    // windowStart == 2026-06-01, deposit on 2026-05-20 is already in
    // the £1,000 starting equity and must be ignored by the summary.
    const rows = windowRows("2026-06-01", 1_000, "2026-06-15", 15, 0);
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-05-20", amount: 500 },
      { portfolio_id: "live-1", date: "2026-06-01", amount: 100 }, // on start
    ];
    const s = computeModeSummary(rows, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(15, 10);
    expect(s?.real.pct).toBeCloseTo((15 / 1_000) * 100, 10);
  });

  it("deposit dated exactly on windowEnd IS netted (inclusive right edge)", () => {
    const rows = windowRows("2026-06-01", 1_000, "2026-06-07", 5, 1_000);
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-06-07", amount: 1_000 },
    ];
    const s = computeModeSummary(rows, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(5, 10);
  });

  it("withdrawal-only window: negative cash-flow is netted symmetrically", () => {
    // −£300 withdrawal + £12 trading. Raw delta = −288, pnl = +12.
    const rows = windowRows("2026-06-01", 2_000, "2026-06-14", 12, -300);
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-06-05", amount: -300 },
    ];
    const s = computeModeSummary(rows, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(12, 10);
    expect(s?.real.pct).toBeCloseTo((12 / 2_000) * 100, 10);
  });

  it("includeDeposits:true across a multi-deposit window returns RAW equity change", () => {
    // Opt-in raw view: pnl == now − previous, deposits included.
    const rows = windowRows("2026-06-01", 1_000, "2026-06-30", 30, 650);
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-06-05", amount: 200 },
      { portfolio_id: "live-1", date: "2026-06-12", amount: 500 },
      { portfolio_id: "live-1", date: "2026-06-20", amount: -100 },
      { portfolio_id: "live-1", date: "2026-06-28", amount: 50 },
    ];
    const s = computeModeSummary(rows, [LIVE], deposits, { includeDeposits: true });
    expect(s?.real.pnl).toBeCloseTo(680, 10); // 30 trading + 650 cash
    expect(s?.real.pct).toBeCloseTo((680 / 1_000) * 100, 10);
  });

  it("YTD-style long window: negative trading PnL nets deposits correctly", () => {
    // Drawdown scenario: +£400 net deposits, −£150 trading. Pnl = −£150.
    const rows = windowRows("2026-01-01", 5_000, "2026-07-27", -150, 400);
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-02-14", amount: 250 },
      { portfolio_id: "live-1", date: "2026-04-01", amount: 250 },
      { portfolio_id: "live-1", date: "2026-06-10", amount: -100 },
    ];
    const s = computeModeSummary(rows, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(-150, 10);
    expect(s?.real.pct).toBeCloseTo((-150 / 5_000) * 100, 10);
  });
});
