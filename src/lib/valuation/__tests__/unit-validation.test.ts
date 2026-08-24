import { describe, it, expect } from "vitest";
import {
  classifyCurrencyUnit,
  unitsDisagree,
  checkFillUnits,
  checkChargeUnits,
  summariseUnitChecks,
} from "../unit-validation";

describe("classifyCurrencyUnit", () => {
  it("treats GBp as pence and GBP as pounds", () => {
    expect(classifyCurrencyUnit("GBp")).toMatchObject({ code: "GBP", minor: true, scale: 0.01 });
    expect(classifyCurrencyUnit("GBP")).toMatchObject({ code: "GBP", minor: false, scale: 1 });
    expect(classifyCurrencyUnit("GBX")).toMatchObject({ code: "GBP", minor: true });
  });

  it("detects scale disagreement between two labels of the same money", () => {
    expect(unitsDisagree("GBp", "GBP")).toBe(true);
    expect(unitsDisagree("GBP", "GBP")).toBe(false);
    expect(unitsDisagree("GBP", "USD")).toBe(false);
  });
});

describe("checkFillUnits", () => {
  it("rescales a minor-unit label without blocking", () => {
    const r = checkFillUnits({ symbol: "VOD.L", price: 1556.2, currency: "GBp" });
    expect(r.blocked).toBe(false);
    expect(r.normalised.price).toBeCloseTo(15.562, 6);
    expect(r.normalised.currency).toBe("GBP");
  });

  it("blocks a pence price labelled GBP against a pounds reference", () => {
    const r = checkFillUnits({
      symbol: "VOD.L",
      price: 1556.2,
      currency: "GBP",
      referencePrice: 15.56,
    });
    expect(r.blocked).toBe(true);
    expect(r.flags.some((f) => f.code === "price_scale_mismatch")).toBe(true);
  });

  it("blocks a double-folded price", () => {
    const r = checkFillUnits({
      symbol: "VOD.L",
      price: 0.1556,
      currency: "GBP",
      referencePrice: 15.56,
    });
    expect(r.blocked).toBe(true);
  });

  it("passes a consistent row cleanly", () => {
    const r = checkFillUnits({
      symbol: "AAPL",
      price: 210,
      currency: "USD",
      referencePrice: 208,
    });
    expect(r.blocked).toBe(false);
    expect(r.flags).toHaveLength(0);
  });
});

describe("checkChargeUnits", () => {
  const base = {
    symbol: "VOD.L",
    quantity: 100,
    fillPrice: 15.5,
    fillCurrency: "GBP",
  };

  it("accepts a normal charge", () => {
    const r = checkChargeUnits({ ...base, chargeTotal: 8, chargeCurrency: "GBP" });
    expect(r.blocked).toBe(false);
    expect(r.normalised.fee).toBe(8);
  });

  it("rescales a GBp charge onto a GBP fill", () => {
    const r = checkChargeUnits({ ...base, chargeTotal: 540, chargeCurrency: "GBp" });
    expect(r.blocked).toBe(false);
    expect(r.normalised.fee).toBeCloseTo(5.4, 6);
    expect(r.flags.map((f) => f.code)).toContain("minor_unit_label");
  });

  it("blocks a pence charge mislabelled GBP", () => {
    const r = checkChargeUnits({ ...base, chargeTotal: 540, chargeCurrency: "GBP" });
    expect(r.blocked).toBe(true);
    expect(r.flags.some((f) => f.code === "fee_scale_mismatch")).toBe(true);
    expect(r.reason).toBeTruthy();
  });

  it("summarises a batch", () => {
    const results = [
      checkChargeUnits({ ...base, chargeTotal: 8, chargeCurrency: "GBP" }),
      checkChargeUnits({ ...base, chargeTotal: 540, chargeCurrency: "GBp" }),
      checkChargeUnits({ ...base, id: "bad", chargeTotal: 540, chargeCurrency: "GBP" }),
    ];
    const s = summariseUnitChecks(results);
    expect(s).toMatchObject({ checked: 3, rescaled: 1, blocked: 1, blockedIds: ["bad"] });
  });
});
