// Contract: computeModeSummary must net out ALL external cash-flows
// from the pnl/pct headline, not only positive deposits. That includes
// withdrawals (negative amount) and cash transfers between portfolios
// (a matched -X on the source + +X on the destination, potentially
// crossing modes).
//
// The user's stated intent is that cash movement never masquerades as
// trading profit or loss. So:
//   - a mid-window WITHDRAWAL must NOT show as a trading loss
//   - a mid-window DEPOSIT must NOT show as a trading gain (already
//     covered elsewhere; re-asserted for symmetry)
//   - a same-mode transfer (net 0 cash) must be a no-op on that mode
//   - a cross-mode transfer must net out on each mode independently
//   - `includeDeposits: true` reverses the netting for BOTH directions

import { describe, expect, it } from "vitest";
import {
  computeModeSummary,
  type DepositEvent,
  type SummaryPortfolio,
  type SummarySeriesRow,
} from "@/lib/mode-summary";

const SIM: SummaryPortfolio = { id: "sim-1", mode: "paper" };
const SIM_B: SummaryPortfolio = { id: "sim-2", mode: "paper" };
const LIVE: SummaryPortfolio = { id: "live-1", mode: "live_prod" };

describe("computeModeSummary — withdrawals and transfers excluded from pct", () => {
  it("mid-window WITHDRAWAL does not show as a trading loss", () => {
    // Equity drops from 1000 → 800 purely because the user withdrew
    // £200. Trading PnL is £0, so pct MUST be 0.00%.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 1000 },
      { date: "2026-07-21", "live-1": 800 },
    ];
    const withdrawals: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: -200 },
    ];
    const s = computeModeSummary(series, [LIVE], withdrawals);
    expect(s?.real.now).toBe(800);
    expect(s?.real.pnl).toBe(0); // (800 − 1000) − (−200) = 0
    expect(s?.real.pct).toBe(0);
  });

  it("WITHDRAWAL layered on a real trading loss reports only the trading loss", () => {
    // Equity: 1000 → 750. Cash-flow: −200.
    // Trading PnL = (750 − 1000) − (−200) = −50.
    // Capital-adjusted denom = 1000 − 200 = 800.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 1000 },
      { date: "2026-07-21", "live-1": 750 },
    ];
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: -200 },
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(-50);
    expect(s?.real.pct).toBeCloseTo((-50 / 800) * 100, 10);
  });

  it("WITHDRAWAL layered on a real trading gain reports only the trading gain", () => {
    // Equity: 1000 → 900. Cash-flow: −200. Trading PnL = +100.
    // Capital-adjusted denom = 1000 − 200 = 800.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 1000 },
      { date: "2026-07-21", "live-1": 900 },
    ];
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: -200 },
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(100);
    expect(s?.real.pct).toBeCloseTo((100 / 800) * 100, 10);
  });


  it("SAME-MODE internal transfer (net 0 within mode) is a no-op on that mode", () => {
    // £150 moves from sim-1 → sim-2, both simulated. Sim-mode net
    // cash-flow is 0. Equity totals are identical across the window,
    // so pnl/pct MUST be 0.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "sim-1": 500, "sim-2": 500 }, // total 1000
      { date: "2026-07-21", "sim-1": 350, "sim-2": 650 }, // total 1000
    ];
    const transfer: DepositEvent[] = [
      { portfolio_id: "sim-1", date: "2026-07-21", amount: -150 },
      { portfolio_id: "sim-2", date: "2026-07-21", amount: 150 },
    ];
    const s = computeModeSummary(series, [SIM, SIM_B], transfer);
    expect(s?.sim.now).toBe(1000);
    expect(s?.sim.pnl).toBe(0);
    expect(s?.sim.pct).toBe(0);
  });

  it("CROSS-MODE transfer nets out on each mode independently", () => {
    // £200 leaves live → sim on 2026-07-21. Neither mode did any real
    // trading, so both modes must report pnl 0, pct 0.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "sim-1": 500, "live-1": 1000 },
      { date: "2026-07-21", "sim-1": 700, "live-1": 800 },
    ];
    const transfer: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: -200 },
      { portfolio_id: "sim-1", date: "2026-07-21", amount: 200 },
    ];
    const s = computeModeSummary(series, [SIM, LIVE], transfer);
    expect(s?.real.pnl).toBe(0);
    expect(s?.real.pct).toBe(0);
    expect(s?.sim.pnl).toBe(0);
    expect(s?.sim.pct).toBe(0);
  });

  it("cross-mode transfer + real trading gain: each mode reports its own trading pnl", () => {
    // Live withdraws £200 to sim (transfer). Live also gained £50 from
    // trading, sim lost £30 from trading.
    // Live: 1000 → 850, netFlow=-200, trading=50, denom=1000-200=800.
    // Sim : 500  → 670, netFlow=+200, trading=-30, denom=500+200=700.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "sim-1": 500, "live-1": 1000 },
      { date: "2026-07-21", "sim-1": 670, "live-1": 850 },
    ];
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: -200 },
      { portfolio_id: "sim-1", date: "2026-07-21", amount: 200 },
    ];
    const s = computeModeSummary(series, [SIM, LIVE], events);
    expect(s?.real.pnl).toBe(50);
    expect(s?.real.pct).toBeCloseTo((50 / 800) * 100, 10);
    expect(s?.sim.pnl).toBe(-30);
    expect(s?.sim.pct).toBeCloseTo((-30 / 700) * 100, 10);
  });


  it("withdrawal dated on/before the previous snapshot is already baked in — no double-net", () => {
    // Withdrawal on 2026-07-19 is BEFORE the previous-window anchor
    // (2026-07-20). It's already reflected in `previous`, so netting
    // it again would flip pnl. Contract: it must be ignored.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 800 }, // already post-withdrawal
      { date: "2026-07-21", "live-1": 820 }, // £20 trading gain
    ];
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-19", amount: -200 },
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(20);
    expect(s?.real.pct).toBeCloseTo(2.5, 10);
  });

  it("withdrawal dated AFTER the last snapshot does not affect the summary", () => {
    // Future-dated withdrawal must have no effect on today's headline.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 1000 },
      { date: "2026-07-21", "live-1": 1050 },
    ];
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-22", amount: -300 },
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(50);
    expect(s?.real.pct).toBeCloseTo(5, 10);
  });

  it("withdrawal targeting a DIFFERENT portfolio in the same mode is still netted for that mode's total", () => {
    // Two sim portfolios. sim-2 sees a £100 withdrawal on 07-21.
    // Sim-mode total: 1000 → 940. Cash-flow: −100. Trading pnl = +40.
    // Capital-adjusted denom = 1000 − 100 = 900.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "sim-1": 400, "sim-2": 600 },
      { date: "2026-07-21", "sim-1": 420, "sim-2": 520 },
    ];
    const events: DepositEvent[] = [
      { portfolio_id: "sim-2", date: "2026-07-21", amount: -100 },
    ];
    const s = computeModeSummary(series, [SIM, SIM_B], events);
    expect(s?.sim.now).toBe(940);
    expect(s?.sim.pnl).toBe(40);
    expect(s?.sim.pct).toBeCloseTo((40 / 900) * 100, 10);
  });

  it("withdrawal on a DIFFERENT mode does not leak into this mode's pnl", () => {
    // Sim-only withdrawal must not touch real-mode pnl, and vice versa.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "sim-1": 500, "live-1": 1000 },
      { date: "2026-07-21", "sim-1": 400, "live-1": 1010 },
    ];
    const events: DepositEvent[] = [
      { portfolio_id: "sim-1", date: "2026-07-21", amount: -100 },
    ];
    const s = computeModeSummary(series, [SIM, LIVE], events);
    // Sim withdrew £100, so trading pnl = 0.
    expect(s?.sim.pnl).toBe(0);
    expect(s?.sim.pct).toBe(0);
    // Live untouched by the sim withdrawal.
    expect(s?.real.pnl).toBe(10);
    expect(s?.real.pct).toBeCloseTo(1, 10);
  });

  it("mixed deposit + withdrawal on the same day are summed as net cash-flow", () => {
    // Same day: +£300 deposit and −£100 withdrawal → net +£200.
    // Equity moves 1000 → 1250. Trading pnl = 250 − 200 = 50.
    // Capital-adjusted denom = 1000 + 200 = 1200.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 1000 },
      { date: "2026-07-21", "live-1": 1250 },
    ];
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: 300 },
      { portfolio_id: "live-1", date: "2026-07-21", amount: -100 },
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(50);
    expect(s?.real.pct).toBeCloseTo((50 / 1200) * 100, 10);
  });


  it("includeDeposits: true reverses the netting for withdrawals too (symmetry)", () => {
    // With the toggle ON, raw equity delta is reported — a withdrawal
    // shows as a "loss", matching the raw-equity view the toggle
    // promises. This locks the toggle's semantics for both signs.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "live-1": 1000 },
      { date: "2026-07-21", "live-1": 800 },
    ];
    const withdrawal: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: -200 },
    ];
    const s = computeModeSummary(series, [LIVE], withdrawal, {
      includeDeposits: true,
    });
    expect(s?.real.pnl).toBe(-200);
    expect(s?.real.pct).toBeCloseTo(-20, 10);
  });
});
