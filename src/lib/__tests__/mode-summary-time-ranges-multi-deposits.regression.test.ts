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
  // Denominator is capital-adjusted (startEquity + net in-window flows)
  // so a large mid-window deposit cannot divide small trading PnL by a
  // tiny pre-deposit baseline. See computeModeSummary docstring.
  const expectedPct = (tradingPnl: number, startEquity: number, inWindowFlows: number) =>
    (tradingPnl / (startEquity + inWindowFlows)) * 100;

  it("7-day window with a single mid-window deposit → deposit netted, pnl == trading only", () => {
    const rows = windowRows("2026-06-01", 1_000, "2026-06-07", 5, 100);
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-06-03", amount: 100 },
    ];
    const s = computeModeSummary(rows, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(5, 10);
    expect(s?.real.pct).toBeCloseTo(expectedPct(5, 1_000, 100), 10);
  });

  it("30-day window with three deposits + one withdrawal → all netted, pnl == £30", () => {
    const rows = windowRows("2026-06-01", 1_000, "2026-06-30", 30, 650);
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-06-05", amount: 200 },
      { portfolio_id: "live-1", date: "2026-06-12", amount: 500 },
      { portfolio_id: "live-1", date: "2026-06-20", amount: -100 },
      { portfolio_id: "live-1", date: "2026-06-28", amount: 50 },
    ];
    const s = computeModeSummary(rows, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(30, 10);
    expect(s?.real.pct).toBeCloseTo(expectedPct(30, 1_000, 650), 10);
  });

  it("90-day (quarter) window with 5 deposits → pnl == pure trading PnL, £89", () => {
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
    expect(s?.real.pct).toBeCloseTo(expectedPct(89, 1_000, 1_650), 10);
  });

  it("pnl is invariant to the NUMBER of deposit events (same net cash-flow)", () => {
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
      expect(s?.real.pct).toBeCloseTo(expectedPct(20, 1_000, 500), 10);
    }
  });

  it("pct scales linearly with trading PnL when the anchor equity is fixed", () => {
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-06-05", amount: 200 },
      { portfolio_id: "live-1", date: "2026-06-15", amount: 300 },
    ];
    for (const trading of [0, 10, 50, 250, -75]) {
      const rows = windowRows("2026-06-01", 1_000, "2026-06-30", trading, 500);
      const s = computeModeSummary(rows, [LIVE], deposits);
      expect(s?.real.pnl).toBeCloseTo(trading, 10);
      expect(s?.real.pct).toBeCloseTo(expectedPct(trading, 1_000, 500), 10);
    }
  });

  it("deposit dated on/before windowStart is NOT re-netted (no double-count)", () => {
    const rows = windowRows("2026-06-01", 1_000, "2026-06-15", 15, 0);
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-05-20", amount: 500 },
      { portfolio_id: "live-1", date: "2026-06-01", amount: 100 }, // on start
    ];
    const s = computeModeSummary(rows, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(15, 10);
    expect(s?.real.pct).toBeCloseTo(expectedPct(15, 1_000, 0), 10);
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
    const rows = windowRows("2026-06-01", 2_000, "2026-06-14", 12, -300);
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-06-05", amount: -300 },
    ];
    const s = computeModeSummary(rows, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(12, 10);
    expect(s?.real.pct).toBeCloseTo(expectedPct(12, 2_000, -300), 10);
  });

  it("includeDeposits:true across a multi-deposit window returns RAW equity change", () => {
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
    const rows = windowRows("2026-01-01", 5_000, "2026-07-27", -150, 400);
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-02-14", amount: 250 },
      { portfolio_id: "live-1", date: "2026-04-01", amount: 250 },
      { portfolio_id: "live-1", date: "2026-06-10", amount: -100 },
    ];
    const s = computeModeSummary(rows, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(-150, 10);
    expect(s?.real.pct).toBeCloseTo(expectedPct(-150, 5_000, 400), 10);
  });

  it("large deposit relative to baseline no longer explodes the percentage", () => {
    // The Balanced-sim bug: £1,000 baseline, £999,000 mid-window
    // deposit, +£11,116 trading PnL. Old formula divided by £1,000
    // and reported +1,111.6% — a nonsense figure. Capital-adjusted
    // denominator (baseline + net flows) yields the realistic figure.
    const rows = windowRows("2026-07-01", 1_000, "2026-07-27", 11_116, 999_000);
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-24", amount: 999_000 },
    ];
    const s = computeModeSummary(rows, [LIVE], deposits);
    expect(s?.real.pnl).toBeCloseTo(11_116, 10);
    expect(s?.real.pct).toBeCloseTo(
      (11_116 / (1_000 + 999_000)) * 100,
      10,
    );
    // Sanity: nowhere near the 1000%+ that the old formula produced.
    expect(Math.abs(s!.real.pct)).toBeLessThan(10);
  });
});

