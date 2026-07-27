// Contract: computeModeSummary's pnl/pct MUST reflect trading PnL only.
// Any non-trading cash-flow booked to the account — broker fees,
// commissions, dividends, and interest (credit or debit) — is a
// cash-flow event, not trading PnL, and must be netted out of the
// window delta exactly the same way user deposits and withdrawals are.
//
// The public DepositEvent type is intentionally a generic
// { portfolio_id, date, amount } cash-flow record. Callers are
// expected to include fees / dividends / interest in the `deposits`
// argument (with the sign convention: positive = credit to the
// account, negative = debit). These tests lock that contract from the
// summary's side: whatever the source, the same amount is netted so
// non-trading flows never masquerade as trading gains or losses.
//
// Sign convention exercised:
//   fees / commissions  → negative amount (money leaves the account)
//   dividends           → positive amount (credit into the account)
//   interest received   → positive amount
//   margin / cash interest debit → negative amount

import { describe, expect, it } from "vitest";
import {
  computeModeSummary,
  type DepositEvent,
  type SummaryPortfolio,
  type SummarySeriesRow,
} from "@/lib/mode-summary";

const LIVE: SummaryPortfolio = { id: "live-1", mode: "live_prod" };

/** Convenience: a two-point window with one live portfolio. */
function twoPointSeries(prev: number, now: number): SummarySeriesRow[] {
  return [
    { date: "2026-07-20", "live-1": prev },
    { date: "2026-07-21", "live-1": now },
  ];
}

describe("computeModeSummary — fees, dividends, interest excluded from pct", () => {
  it("BROKER FEE (debit) is netted out — a pure fee-only day is not a trading loss", () => {
    // Equity moves 1000 → 995 solely because the broker charged £5 in
    // commissions on trades that netted flat. Trading PnL is £0, so
    // pnl/pct MUST be 0.00 / 0.00%.
    const series = twoPointSeries(1000, 995);
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: -5 }, // fee
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(0);
    expect(s?.real.pct).toBe(0);
  });

  it("DIVIDEND (credit) is netted out — a dividend-only day is not a trading gain", () => {
    // Equity moves 1000 → 1012 solely from a £12 dividend payment.
    // Trading PnL is £0.
    const series = twoPointSeries(1000, 1012);
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: 12 }, // dividend
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(0);
    expect(s?.real.pct).toBe(0);
  });

  it("INTEREST RECEIVED (credit) is netted out — interest is not a trading gain", () => {
    // Broker paid £3 in cash interest overnight. Equity: 1000 → 1003.
    // Trading PnL is £0.
    const series = twoPointSeries(1000, 1003);
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: 3 }, // interest
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(0);
    expect(s?.real.pct).toBe(0);
  });

  it("INTEREST DEBIT is netted out — cash-interest charge is not a trading loss", () => {
    // Broker charged £7 in cash-interest. Equity: 1000 → 993.
    const series = twoPointSeries(1000, 993);
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: -7 },
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(0);
    expect(s?.real.pct).toBe(0);
  });

  it("FEE + trading gain: reports only the trading gain", () => {
    // £50 trading gain, £5 fee → equity 1000 → 1045.
    // Trading pnl = (1045 − 1000) − (−5) = 50. Denominator is
    // capital-adjusted (prev + net flows = 1000 + (−5) = 995).
    const series = twoPointSeries(1000, 1045);
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: -5 },
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(50);
    expect(s?.real.pct).toBeCloseTo((50 / 995) * 100, 10);
  });

  it("DIVIDEND + trading loss: reports only the trading loss", () => {
    // £30 dividend received, £30 trading loss → equity 1000 → 1000.
    // Trading pnl = (1000 − 1000) − 30 = −30. Capital-adjusted
    // denominator = 1000 + 30 = 1030.
    const series = twoPointSeries(1000, 1000);
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: 30 },
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(-30);
    expect(s?.real.pct).toBeCloseTo((-30 / 1030) * 100, 10);
  });

  it("FEE + DIVIDEND + INTEREST + DEPOSIT + trading gain: only the trading gain shows", () => {
    // Mixed non-trading flows all land on 2026-07-21:
    //   fee      −8, dividend +25, interest +2, deposit +100
    //   net cash-flow = +119
    // Equity moves 1000 → 1159, so trading pnl = (1159−1000) − 119 = 40.
    // Denominator is capital-adjusted: 1000 + 119 = 1119.
    const series = twoPointSeries(1000, 1159);
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: -8 },
      { portfolio_id: "live-1", date: "2026-07-21", amount: 25 },
      { portfolio_id: "live-1", date: "2026-07-21", amount: 2 },
      { portfolio_id: "live-1", date: "2026-07-21", amount: 100 },
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(40);
    expect(s?.real.pct).toBeCloseTo((40 / 1119) * 100, 10);
  });


  it("FEES / DIVIDENDS / INTEREST dated ON OR BEFORE the previous snapshot are not double-netted", () => {
    // Fees & dividends dated 2026-07-19 are already baked into the
    // previous-window anchor (2026-07-20). Netting them again would
    // corrupt pnl. Contract: they must be ignored.
    const series = twoPointSeries(950, 970); // pure £20 trading gain
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-19", amount: -5 },  // fee
      { portfolio_id: "live-1", date: "2026-07-19", amount: 15 },  // dividend
      { portfolio_id: "live-1", date: "2026-07-20", amount: 3 },   // interest, on prev anchor
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(20);
    expect(s?.real.pct).toBeCloseTo((20 / 950) * 100, 10);
  });

  it("FEES / DIVIDENDS dated AFTER the last snapshot do not affect the summary", () => {
    // Future-dated non-trading cash-flows must have no effect on the
    // headline pnl or pct.
    const series = twoPointSeries(1000, 1050); // £50 trading gain
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-22", amount: -20 }, // fee
      { portfolio_id: "live-1", date: "2026-07-23", amount: 40 },  // dividend
    ];
    const s = computeModeSummary(series, [LIVE], events);
    expect(s?.real.pnl).toBe(50);
    expect(s?.real.pct).toBeCloseTo(5, 10);
  });

  it("non-trading cash-flow scoped to a DIFFERENT portfolio does not leak into this mode's pnl", () => {
    // Sim portfolio receives a £40 dividend; live portfolio is pure
    // trading. Live's pnl must be unaffected by sim's dividend.
    const SIM: SummaryPortfolio = { id: "sim-1", mode: "paper" };
    const series: SummarySeriesRow[] = [
      { date: "2026-07-20", "sim-1": 500, "live-1": 1000 },
      { date: "2026-07-21", "sim-1": 540, "live-1": 1020 },
    ];
    const events: DepositEvent[] = [
      { portfolio_id: "sim-1", date: "2026-07-21", amount: 40 }, // sim dividend
    ];
    const s = computeModeSummary(series, [SIM, LIVE], events);
    // Live: pure trading gain of £20.
    expect(s?.real.pnl).toBe(20);
    expect(s?.real.pct).toBeCloseTo(2, 10);
    // Sim: dividend fully explains the equity move → trading pnl 0.
    expect(s?.sim.pnl).toBe(0);
    expect(s?.sim.pct).toBe(0);
  });

  it("includeDeposits: true reverses the netting for fees / dividends / interest too", () => {
    // With the toggle ON, raw equity delta is reported — non-trading
    // flows count toward the headline. Locks the toggle's semantics
    // for all cash-flow kinds, not just user deposits.
    const series = twoPointSeries(1000, 1030);
    const events: DepositEvent[] = [
      { portfolio_id: "live-1", date: "2026-07-21", amount: -5 },  // fee
      { portfolio_id: "live-1", date: "2026-07-21", amount: 25 },  // dividend
      { portfolio_id: "live-1", date: "2026-07-21", amount: 10 },  // interest
    ];
    const s = computeModeSummary(series, [LIVE], events, {
      includeDeposits: true,
    });
    // Raw delta = 30; toggle ON means we do NOT net anything out.
    expect(s?.real.pnl).toBe(30);
    expect(s?.real.pct).toBeCloseTo(3, 10);
  });

  it("many-day window: only flows AFTER prev anchor are netted", () => {
    // Window boundaries under computeModeSummary are the LAST two rows
    // that have a real-mode value. Fees on earlier historical days do
    // NOT enter the trailing-window netting.
    const series: SummarySeriesRow[] = [
      { date: "2026-07-17", "live-1": 900 },
      { date: "2026-07-18", "live-1": 940 },  // historical fee day
      { date: "2026-07-19", "live-1": 970 },
      { date: "2026-07-20", "live-1": 1000 }, // <-- prev anchor
      { date: "2026-07-21", "live-1": 1035 }, // <-- last (£35 raw delta)
    ];
    const events: DepositEvent[] = [
      // Historical dividend — must NOT touch the trailing window.
      { portfolio_id: "live-1", date: "2026-07-18", amount: 50 },
      // In-window fee & dividend that DO net into the trailing pnl.
      { portfolio_id: "live-1", date: "2026-07-21", amount: -5 },
      { portfolio_id: "live-1", date: "2026-07-21", amount: 20 },
    ];
    const s = computeModeSummary(series, [LIVE], events);
    // Trailing net non-trading flow = 15 (20 − 5).
    // Trading pnl = 35 − 15 = 20. Capital-adjusted denom = 1000 + 15.
    expect(s?.real.pnl).toBe(20);
    expect(s?.real.pct).toBeCloseTo((20 / 1015) * 100, 10);
  });

});
