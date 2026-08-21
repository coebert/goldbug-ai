import { describe, expect, it } from "vitest";
import { discrepancyAlertKey } from "../trade-leg-reconciliation";

const base = { symbolKey: "MKS", side: "sell" as const };

describe("discrepancyAlertKey", () => {
  it("is stable across ticks for dropped legs (new decision/order ids)", () => {
    const a = discrepancyAlertKey({ ...base, code: "dropped_leg" });
    const b = discrepancyAlertKey({ ...base, code: "dropped_leg" });
    expect(a).toBe(b);
  });

  it("separates sides and symbols", () => {
    expect(discrepancyAlertKey({ ...base, code: "side_mismatch" })).not.toBe(
      discrepancyAlertKey({ ...base, side: "buy", code: "side_mismatch" }),
    );
    expect(discrepancyAlertKey({ ...base, code: "side_mismatch" })).not.toBe(
      discrepancyAlertKey({ ...base, symbolKey: "AAPL", code: "side_mismatch" }),
    );
  });

  it("collapses similar quantity gaps but escalates materially worse ones", () => {
    const small = discrepancyAlertKey({
      ...base,
      code: "quantity_short",
      intendedQuantity: 100,
      executedQuantity: 95,
    });
    const alsoSmall = discrepancyAlertKey({
      ...base,
      code: "quantity_short",
      intendedQuantity: 100,
      executedQuantity: 88,
    });
    const large = discrepancyAlertKey({
      ...base,
      code: "quantity_short",
      intendedQuantity: 100,
      executedQuantity: 20,
    });
    expect(small).toBe(alsoSmall);
    expect(small).not.toBe(large);
  });

  it("buckets price deviation in 100bps steps and caps extremes", () => {
    expect(
      discrepancyAlertKey({ ...base, code: "price_deviation", priceDeviationBps: 160 }),
    ).toBe(discrepancyAlertKey({ ...base, code: "price_deviation", priceDeviationBps: -190 }));
    expect(
      discrepancyAlertKey({ ...base, code: "price_deviation", priceDeviationBps: 160 }),
    ).not.toBe(
      discrepancyAlertKey({ ...base, code: "price_deviation", priceDeviationBps: 640 }),
    );
    expect(
      discrepancyAlertKey({ ...base, code: "price_deviation", priceDeviationBps: 5000 }),
    ).toBe(
      discrepancyAlertKey({ ...base, code: "price_deviation", priceDeviationBps: 90000 }),
    );
  });
});
