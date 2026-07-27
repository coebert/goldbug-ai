import { describe, it, expect } from "vitest";
import { summarizeOutcomes } from "../trade-outcome-summary";
import type { TradeOutcomeRow } from "../trade-outcomes.functions";

function row(overrides: Partial<TradeOutcomeRow>): TradeOutcomeRow {
  return {
    id: crypto.randomUUID(),
    createdAt: "2026-07-27T09:00:00Z",
    updatedAt: "2026-07-27T09:00:01Z",
    submittedAt: null,
    symbol: "AAPL:xnas",
    side: "buy",
    quantity: 10,
    orderType: "market",
    limitPrice: null,
    status: "filled",
    brokerOrderId: null,
    clientOrderId: null,
    rejectReason: null,
    instrumentCcy: "USD",
    fills: [],
    filledQty: 10,
    avgFillPrice: 100,
    ...overrides,
  };
}

describe("summarizeOutcomes", () => {
  it("returns zeros for an empty input", () => {
    const s = summarizeOutcomes([]);
    expect(s.total).toBe(0);
    expect(s.fillRatePct).toBe(0);
    expect(s.avgSlippageBps).toBeNull();
    expect(s.errorCount).toBe(0);
  });

  it("computes fill rate, volume-fill rate and error/cancel counts", () => {
    const rows = [
      row({ status: "filled", quantity: 10, filledQty: 10 }),
      row({ status: "partially_filled", quantity: 20, filledQty: 5 }),
      row({ status: "working", quantity: 10, filledQty: 0 }),
      row({ status: "rejected", quantity: 8, filledQty: 0 }),
      row({ status: "error", quantity: 4, filledQty: 0 }),
      row({ status: "cancelled", quantity: 2, filledQty: 0 }),
    ];
    const s = summarizeOutcomes(rows);
    expect(s.total).toBe(6);
    expect(s.filled).toBe(1);
    expect(s.partial).toBe(1);
    expect(s.working).toBe(1);
    expect(s.errorCount).toBe(2);
    expect(s.cancelledCount).toBe(1);
    expect(s.failed).toBe(3);
    // 2 of 6 (filled + partial) → 33.33%
    expect(s.fillRatePct).toBeCloseTo((2 / 6) * 100, 5);
    // 15 filled of 54 requested → 27.78%
    expect(s.volumeFillRatePct).toBeCloseTo((15 / 54) * 100, 5);
  });

  it("computes volume-weighted slippage in bps for limit orders (buy side positive = worse)", () => {
    const rows = [
      // Buy limit at 100, filled at 100.05 → +5 bps, weight 10
      row({
        side: "buy",
        orderType: "limit",
        limitPrice: 100,
        avgFillPrice: 100.05,
        filledQty: 10,
        status: "filled",
      }),
      // Buy limit at 200, filled at 200.30 → +15 bps, weight 30
      row({
        side: "buy",
        orderType: "limit",
        limitPrice: 200,
        avgFillPrice: 200.3,
        filledQty: 30,
        status: "filled",
      }),
      // Sell limit at 50, filled at 50.05 → -10 bps (better than limit), weight 10
      row({
        side: "sell",
        orderType: "limit",
        limitPrice: 50,
        avgFillPrice: 50.05,
        filledQty: 10,
        status: "filled",
      }),
      // Market fill → excluded
      row({ orderType: "market", filledQty: 5, avgFillPrice: 42, status: "filled" }),
      // Limit but no fill → excluded
      row({
        orderType: "limit",
        limitPrice: 10,
        avgFillPrice: null,
        filledQty: 0,
        status: "working",
      }),
    ];
    const s = summarizeOutcomes(rows);
    expect(s.slippageSampleCount).toBe(3);
    const expected = (5 * 10 + 15 * 30 + -10 * 10) / (10 + 30 + 10);
    expect(s.avgSlippageBps).toBeCloseTo(expected, 5);
  });

  it("returns null slippage when no limit orders have filled", () => {
    const rows = [
      row({ orderType: "market", status: "filled" }),
      row({ orderType: "limit", limitPrice: 100, filledQty: 0, avgFillPrice: null, status: "rejected" }),
    ];
    const s = summarizeOutcomes(rows);
    expect(s.avgSlippageBps).toBeNull();
    expect(s.slippageSampleCount).toBe(0);
  });
});
