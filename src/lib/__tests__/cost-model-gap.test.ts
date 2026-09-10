import { describe, expect, it } from "vitest";
import { buildCostModelGap, type CostGapOrder } from "../cost-model-gap";
import { resolveAssumptions } from "../backtest/execution-assumptions";

const assumptions = resolveAssumptions("realistic");

const order = (over: Partial<CostGapOrder> = {}): CostGapOrder => ({
  id: "o1",
  symbol: "AAPL:xnas",
  side: "buy",
  orderedQuantity: 10,
  status: "filled",
  createdAt: "2026-09-01T08:00:00Z",
  fills: [
    {
      quantity: 10,
      priceBase: 100,
      feeBase: 4,
      feeSource: "broker",
      filledAt: "2026-09-01T08:01:00Z",
    },
  ],
  ...over,
});

describe("buildCostModelGap", () => {
  it("compares the real charge against the modelled ticket cost", () => {
    const { rows, summary } = buildCostModelGap([order()], assumptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notionalBase).toBe(1000);
    expect(rows[0]!.actualFeeBase).toBe(4);
    expect(rows[0]!.modelledFeeBase).toBeGreaterThan(0);
    expect(rows[0]!.feeGapBase).toBeCloseTo(4 - rows[0]!.modelledFeeBase, 6);
    expect(summary.feeGapBase).toBeCloseTo(rows[0]!.feeGapBase, 6);
  });

  it("tracks partial and unfilled orders in the fill rate", () => {
    const partial = order({
      id: "o2",
      orderedQuantity: 20,
      status: "partial",
      fills: [
        {
          quantity: 5,
          priceBase: 100,
          feeBase: 3,
          feeSource: "model",
          filledAt: "2026-09-02T08:01:00Z",
        },
      ],
    });
    const none = order({ id: "o3", orderedQuantity: 10, status: "cancelled", fills: [] });
    const { summary } = buildCostModelGap([order(), partial, none], assumptions);
    expect(summary.orders).toBe(3);
    expect(summary.fullyFilled).toBe(1);
    expect(summary.partiallyFilled).toBe(1);
    expect(summary.unfilled).toBe(1);
    // 15 of 40 requested shares traded.
    expect(summary.fillRate).toBeCloseTo(15 / 40, 6);
  });

  it("reports how much of the charge is broker-billed", () => {
    const estimated = order({
      id: "o4",
      fills: [
        {
          quantity: 10,
          priceBase: 100,
          feeBase: 4,
          feeSource: "model",
          filledAt: "2026-09-03T08:01:00Z",
        },
      ],
    });
    const { summary } = buildCostModelGap([order(), estimated], assumptions);
    expect(summary.brokerBilledShare).toBeCloseTo(0.5, 6);
  });

  it("marks orders that cost more than the model as under-modelled", () => {
    const pricey = order({
      id: "o5",
      fills: [
        {
          quantity: 10,
          priceBase: 100,
          feeBase: 40,
          feeSource: "broker",
          filledAt: "2026-09-04T08:01:00Z",
        },
      ],
    });
    const { summary } = buildCostModelGap([pricey], assumptions);
    expect(summary.underModelled).toBe(1);
    expect(summary.feeGapBps).toBeGreaterThan(0);
  });

  it("ignores unfilled orders when pricing the model cost", () => {
    const { rows } = buildCostModelGap(
      [order({ id: "o6", fills: [], status: "cancelled" })],
      assumptions,
    );
    expect(rows[0]!.modelledFeeBase).toBe(0);
    expect(rows[0]!.actualFeeBase).toBe(0);
    expect(rows[0]!.fillRate).toBe(0);
  });
});
