import { describe, it, expect } from "vitest";
import { buildTradeCostBreakdown, type TradeCostFill } from "../trade-cost-breakdown";

const fill = (o: Partial<TradeCostFill> & Pick<TradeCostFill, "id" | "side">): TradeCostFill => ({
  symbol: "AAPL:xnas",
  quantity: 10,
  priceBase: 100,
  feeBase: 10,
  feeSource: "broker",
  filledAt: "2026-09-01T09:00:00Z",
  ...o,
});

describe("trade cost breakdown", () => {
  it("splits itemised charges and prices them in bps", () => {
    const { rows } = buildTradeCostBreakdown(
      [
        fill({
          id: "1",
          side: "buy",
          feeBase: 12,
          commissionBase: 5,
          taxBase: 5,
          exchangeBase: 2,
        }),
      ],
      500,
    );
    const r = rows[0]!;
    expect(r.grossBase).toBe(1000);
    expect(r.commissionBase).toBe(5);
    expect(r.taxBase).toBe(5);
    expect(r.exchangeBase).toBe(2);
    expect(r.otherBase).toBe(0);
    expect(r.totalCostBase).toBe(12);
    expect(r.costBps).toBeCloseTo(120, 5);
    expect(r.itemised).toBe(true);
  });

  it("puts an unexplained remainder into other rather than losing it", () => {
    const { rows } = buildTradeCostBreakdown(
      [fill({ id: "1", side: "buy", feeBase: 20, commissionBase: 5 })],
      0,
    );
    expect(rows[0]!.otherBase).toBe(15);
    expect(rows[0]!.commissionBase + rows[0]!.otherBase).toBe(rows[0]!.totalCostBase);
  });

  it("never emits a negative line when the named parts exceed the total", () => {
    const { rows } = buildTradeCostBreakdown(
      [fill({ id: "1", side: "buy", feeBase: 4, commissionBase: 5, otherBase: 0 })],
      0,
    );
    expect(rows[0]!.otherBase).toBe(0);
  });

  it("walks cash back from today's balance", () => {
    const { rows, summary } = buildTradeCostBreakdown(
      [
        fill({ id: "1", side: "buy", feeBase: 10 }), // -1010
        fill({ id: "2", side: "sell", feeBase: 10, priceBase: 110 }), // +1090
      ],
      2000,
    );
    expect(rows[1]!.cashLeftBase).toBe(2000);
    expect(rows[1]!.cashDeltaBase).toBe(1090);
    expect(rows[0]!.cashLeftBase).toBe(910);
    expect(summary.cashLeftBase).toBe(2000);
  });

  it("totals charges, splits billed from estimated and names the priciest ticket", () => {
    const { summary } = buildTradeCostBreakdown(
      [
        fill({ id: "1", side: "buy", feeBase: 10, commissionBase: 10 }),
        fill({
          id: "2",
          side: "buy",
          symbol: "TSCO:xlon",
          feeBase: 30,
          commissionBase: 10,
          taxBase: 20,
          feeSource: "model",
        }),
      ],
      100,
    );
    expect(summary.trades).toBe(2);
    expect(summary.totalCostBase).toBe(40);
    expect(summary.commissionBase).toBe(20);
    expect(summary.taxBase).toBe(20);
    expect(summary.brokerBilledBase).toBe(10);
    expect(summary.estimatedBase).toBe(30);
    expect(summary.costBps).toBeCloseTo(200, 5);
    expect(summary.worst?.symbol).toBe("TSCO:xlon");
  });

  it("ignores unusable fills", () => {
    const { summary } = buildTradeCostBreakdown(
      [fill({ id: "1", side: "buy", quantity: 0 }), fill({ id: "2", side: "buy", priceBase: 0 })],
      50,
    );
    expect(summary.trades).toBe(0);
    expect(summary.cashLeftBase).toBe(50);
  });
});
