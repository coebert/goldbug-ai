// Regression: the mode summary tile's % change must EXCLUDE the initial
// cash deposit that seeds a portfolio (e.g. £100 opening balance + £200
// top-up = £300 starting pot). A portfolio that has only ever received
// deposits — with zero trading activity — must report pct = 0.00%, not
// "+∞%" or "+200%". This also covers the case where the first snapshot
// on record IS the initial deposit day (previous == deposit day).
//
// Guards the bug that produced "% change including initial cash deposit"
// on the dashboard tile after seeding a real-money account.

import { describe, expect, it } from "vitest";
import {
  computeModeSummary,
  type DepositEvent,
  type SummaryPortfolio,
  type SummarySeriesRow,
} from "@/lib/mode-summary";

const LIVE: SummaryPortfolio = { id: "live-1", mode: "live_prod" };
const SIM: SummaryPortfolio = { id: "sim-1", mode: "paper" };

describe("computeModeSummary — initial deposit excluded from % change", () => {
  it("initial £100 seed + £200 top-up, no trading → pct = 0%", () => {
    // Day 1: account opened with £100. Day 2: user deposits £200 more.
    // Trading PnL is zero. Equity goes 100 → 300 purely from cash-flow.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 100 },
      { date: "2026-07-21", "live-1": 300 },
    ];
    const deposits: DepositEvent[] = [
      // NB: the £100 opening balance is dated ON the first snapshot day,
      // so it's already baked into `previous` and correctly ignored by
      // the netting window (strictly-after prevDate). Only the £200
      // top-up falls in-window.
      { portfolio_id: "live-1", date: "2026-07-20", amount: 100 },
      { portfolio_id: "live-1", date: "2026-07-21", amount: 200 },
    ];
    const s = computeModeSummary(series, [LIVE], deposits);
    expect(s?.real.now).toBe(300);
    expect(s?.real.pnl).toBe(0);
    expect(s?.real.pct).toBe(0);
  });

  it("initial seed + top-up + small trading gain → pct reflects ONLY the trading gain", () => {
    // 100 → 305: +£200 deposit, +£5 trading profit. pct on £100 = 5%.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 100 },
      { date: "2026-07-21", "live-1": 305 },
    ];
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-20", amount: 100 },
      { portfolio_id: "live-1", date: "2026-07-21", amount: 200 },
    ];
    const s = computeModeSummary(series, [LIVE], deposits);
    expect(s?.real.pnl).toBe(5);
    expect(s?.real.pct).toBeCloseTo(5, 10);
  });

  it("sim portfolio seeded with £1,000,000, no trading → sim pct = 0%", () => {
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "sim-1": 0 },
      { date: "2026-07-21", "sim-1": 1_000_000 },
    ];
    const deposits: DepositEvent[] = [
      { portfolio_id: "sim-1", date: "2026-07-21", amount: 1_000_000 },
    ];
    const s = computeModeSummary(series, [SIM], deposits);
    expect(s?.sim.now).toBe(1_000_000);
    expect(s?.sim.pnl).toBe(0);
    expect(s?.sim.pct).toBe(0);
  });

  it("previous equity == 0 (never funded before top-up) → pct = 0, not Infinity", () => {
    // Denominator guard: previous == 0 → pct must be 0, never
    // NaN/Infinity, even after subtracting the deposit from the numerator.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 0 },
      { date: "2026-07-21", "live-1": 500 },
    ];
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: 500 },
    ];
    const s = computeModeSummary(series, [LIVE], deposits);
    expect(Number.isFinite(s!.real.pct)).toBe(true);
    expect(s?.real.pct).toBe(0);
    expect(s?.real.pnl).toBe(0);
  });

  it("includeDeposits: true reverses the netting (opt-in raw view)", () => {
    // Sanity: when the caller explicitly asks for raw equity change,
    // the deposit IS included. Locks the option contract.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 100 },
      { date: "2026-07-21", "live-1": 300 },
    ];
    const deposits: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: 200 },
    ];
    const s = computeModeSummary(series, [LIVE], deposits, { includeDeposits: true });
    expect(s?.real.pnl).toBe(200);
    expect(s?.real.pct).toBeCloseTo(200, 10);
  });
});
