import { describe, it, expect } from "vitest";
import { computeEquityChangeBreakdown } from "@/lib/equity-change-breakdown";

const eq = (rows: Array<[string, number]>) =>
  rows.map(([snapshot_date, total_value]) => ({ snapshot_date, total_value }));

describe("computeEquityChangeBreakdown", () => {
  it("returns null when there are fewer than 2 snapshots", () => {
    expect(computeEquityChangeBreakdown(eq([["2026-07-01", 1000]]), [])).toBeNull();
  });

  it("attributes a pure trading gain entirely to Trading P&L", () => {
    const b = computeEquityChangeBreakdown(
      eq([
        ["2026-07-01", 1000],
        ["2026-07-30", 1100],
      ]),
      [],
    )!;
    expect(b.totalChange).toBe(100);
    expect(b.totalPct).toBeCloseTo(10, 6);
    const byKey = Object.fromEntries(b.buckets.map((x) => [x.key, x]));
    expect(byKey.tradingPnl.amount).toBe(100);
    expect(byKey.deposits.amount).toBe(0);
    expect(byKey.withdrawals.amount).toBe(0);
    expect(byKey.feesDivInterest.amount).toBe(0);
  });

  it("splits a large positive flow into Deposits, leaving trading P&L clean", () => {
    // Equity 1000 → 1300 with a £200 deposit; trading contributed £100.
    const b = computeEquityChangeBreakdown(
      eq([
        ["2026-07-01", 1000],
        ["2026-07-10", 1150],
        ["2026-07-30", 1300],
      ]),
      [{ date: "2026-07-05", amount: 200 }],
    )!;
    const byKey = Object.fromEntries(b.buckets.map((x) => [x.key, x]));
    expect(byKey.deposits.amount).toBe(200);
    expect(byKey.tradingPnl.amount).toBe(100);
    expect(byKey.feesDivInterest.amount).toBe(0);
    expect(byKey.deposits.pctPoints + byKey.tradingPnl.pctPoints).toBeCloseTo(
      b.totalPct,
      6,
    );
  });

  it("buckets small credits/debits as Fees/Dividends/Interest", () => {
    // 1000 → 1015 driven only by a £12 dividend + £3 interest.
    const b = computeEquityChangeBreakdown(
      eq([
        ["2026-07-01", 1000],
        ["2026-07-30", 1015],
      ]),
      [
        { date: "2026-07-05", amount: 12 }, // dividend
        { date: "2026-07-20", amount: 3 }, // interest
      ],
    )!;
    const byKey = Object.fromEntries(b.buckets.map((x) => [x.key, x]));
    expect(byKey.feesDivInterest.amount).toBe(15);
    expect(byKey.tradingPnl.amount).toBe(0);
    expect(byKey.deposits.amount).toBe(0);
  });

  it("negative small flows (fees / interest debits) bucket as fees, not withdrawals", () => {
    const b = computeEquityChangeBreakdown(
      eq([
        ["2026-07-01", 1000],
        ["2026-07-30", 993],
      ]),
      [{ date: "2026-07-15", amount: -7 }], // cash-interest debit
    )!;
    const byKey = Object.fromEntries(b.buckets.map((x) => [x.key, x]));
    expect(byKey.feesDivInterest.amount).toBe(-7);
    expect(byKey.withdrawals.amount).toBe(0);
    expect(byKey.tradingPnl.amount).toBe(0);
  });

  it("buckets always sum to the total change", () => {
    const b = computeEquityChangeBreakdown(
      eq([
        ["2026-07-01", 1000],
        ["2026-07-30", 1180],
      ]),
      [
        { date: "2026-07-03", amount: 200 }, // deposit
        { date: "2026-07-10", amount: -50 }, // withdrawal
        { date: "2026-07-12", amount: 15 }, // dividend
        { date: "2026-07-20", amount: -5 }, // fee
      ],
    )!;
    const sum = b.buckets.reduce((s, x) => s + x.amount, 0);
    expect(sum).toBeCloseTo(b.totalChange, 6);
    const pctSum = b.buckets.reduce((s, x) => s + x.pctPoints, 0);
    expect(pctSum).toBeCloseTo(b.totalPct, 6);
  });

  it("ignores cash-flows dated on or before the window start", () => {
    const b = computeEquityChangeBreakdown(
      eq([
        ["2026-07-10", 1000],
        ["2026-07-30", 1050],
      ]),
      [
        { date: "2026-07-01", amount: 500 }, // pre-window: baked into 1000
        { date: "2026-07-10", amount: 200 }, // on start: also excluded
        { date: "2026-07-15", amount: 30 }, // in-window deposit
      ],
    )!;
    const byKey = Object.fromEntries(b.buckets.map((x) => [x.key, x]));
    expect(byKey.deposits.amount).toBe(30);
    expect(byKey.tradingPnl.amount).toBe(20);
  });
});
