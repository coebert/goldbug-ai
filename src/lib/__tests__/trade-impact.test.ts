import { describe, expect, it } from "vitest";
import { buildTradeImpact, type TradeImpactFill } from "../trade-impact";

const fill = (o: Partial<TradeImpactFill> & { id: string; side: "buy" | "sell" }): TradeImpactFill => ({
  symbol: "AAPL:xnas",
  quantity: 10,
  priceBase: 100,
  feeBase: 3,
  feeSource: "model",
  filledAt: "2026-09-01T09:00:00Z",
  ...o,
});

describe("buildTradeImpact", () => {
  it("moves cash out on a buy and in on a sell, fees included", () => {
    const impact = buildTradeImpact(
      [fill({ id: "1", side: "buy" }), fill({ id: "2", side: "sell", priceBase: 110 })],
      new Map(),
    );
    expect(impact.rows[0]!.cashDeltaBase).toBe(-1003);
    expect(impact.rows[1]!.cashDeltaBase).toBe(1097);
    expect(impact.summary.netCashBase).toBe(94);
    expect(impact.summary.feesBase).toBe(6);
  });

  it("banks profit on the sell using average cost net of both fees", () => {
    const impact = buildTradeImpact(
      [fill({ id: "1", side: "buy" }), fill({ id: "2", side: "sell", priceBase: 110 })],
      new Map(),
    );
    expect(impact.rows[0]!.realisedBase).toBeNull();
    expect(impact.rows[1]!.realisedBase).toBe(94);
    expect(impact.summary.realisedBase).toBe(94);
    expect(impact.summary.unrealisedBase).toBe(0);
  });

  it("marks the remaining position to the latest price", () => {
    const impact = buildTradeImpact(
      [fill({ id: "1", side: "buy" }), fill({ id: "2", side: "sell", quantity: 4, priceBase: 110 })],
      new Map([["AAPL:xnas", 120]]),
    );
    expect(impact.rows[1]!.positionAfter).toBe(6);
    expect(impact.open[0]!.quantity).toBe(6);
    expect(impact.open[0]!.unrealisedBase).toBeCloseTo(6 * 120 - 601.8, 2);
    expect(impact.summary.totalProfitBase).toBeCloseTo(
      impact.summary.realisedBase + impact.summary.unrealisedBase,
      2,
    );
  });

  it("splits broker-billed and estimated charges and skips junk rows", () => {
    const impact = buildTradeImpact(
      [
        fill({ id: "1", side: "buy", feeSource: "broker", feeBase: 4 }),
        fill({ id: "2", side: "buy", quantity: 0 }),
        fill({ id: "3", side: "buy", priceBase: 0 }),
      ],
      new Map(),
    );
    expect(impact.summary.trades).toBe(1);
    expect(impact.summary.brokerFeesBase).toBe(4);
    expect(impact.summary.estimatedFeesBase).toBe(0);
  });

  it("keeps a running cash and profit trail in fill order", () => {
    const impact = buildTradeImpact(
      [
        fill({ id: "1", side: "buy" }),
        fill({ id: "2", side: "sell", quantity: 5, priceBase: 110 }),
        fill({ id: "3", side: "sell", quantity: 5, priceBase: 90 }),
      ],
      new Map(),
    );
    expect(impact.rows.map((r) => r.runningCashBase)).toEqual([-1003, -456, -9]);
    expect(impact.rows[2]!.runningRealisedBase).toBe(impact.summary.realisedBase);
    expect(impact.open).toHaveLength(0);
  });
});
