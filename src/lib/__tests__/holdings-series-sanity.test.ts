import { describe, it, expect } from "vitest";
import { auditHoldingSeries } from "../holdings-series-sanity";

const base = {
  symbol: "TEST",
  avg_cost: 100,
  closes: [100, 105, 110],
  currentPrice: 110,
  pctChangeSincePurchase: 0.1,
  points: 3,
};

describe("auditHoldingSeries", () => {
  it("passes a consistent series", () => {
    expect(auditHoldingSeries(base)).toEqual([]);
  });

  it("flags length mismatch", () => {
    const issues = auditHoldingSeries({ ...base, points: 4 });
    expect(issues.some((i) => i.code === "length_mismatch")).toBe(true);
  });

  it("flags baseline drift when closes[0] != avg_cost", () => {
    const issues = auditHoldingSeries({ ...base, closes: [99, 105, 110] });
    expect(issues.some((i) => i.code === "baseline_drift")).toBe(true);
  });

  it("flags currentPrice not matching tail", () => {
    const issues = auditHoldingSeries({ ...base, currentPrice: 200 });
    expect(issues.some((i) => i.code === "current_price_drift")).toBe(true);
  });

  it("flags sign disagreement (up sparkline, negative headline)", () => {
    const issues = auditHoldingSeries({
      ...base,
      closes: [100, 105, 110],
      currentPrice: 110,
      pctChangeSincePurchase: -0.05,
    });
    expect(issues.some((i) => i.code === "sign_disagreement")).toBe(true);
  });

  it("flags magnitude disagreement beyond 50bps", () => {
    const issues = auditHoldingSeries({
      ...base,
      pctChangeSincePurchase: 0.5, // sparkline says +10%, headline says +50%
      currentPrice: 110,
    });
    // sign matches, magnitude mismatch fires
    expect(issues.some((i) => i.code === "magnitude_disagreement")).toBe(true);
  });

  it("flags non-finite values", () => {
    const issues = auditHoldingSeries({ ...base, closes: [100, NaN, 110] });
    expect(issues.some((i) => i.code === "non_finite")).toBe(true);
  });

  it("tolerates tiny floating-point drift", () => {
    const issues = auditHoldingSeries({
      ...base,
      closes: [100.0000001, 105, 110.0000001],
      currentPrice: 110,
    });
    expect(issues).toEqual([]);
  });

  it("does not flag flat holdings near zero", () => {
    const issues = auditHoldingSeries({
      symbol: "FLAT",
      avg_cost: 100,
      closes: [100, 100.001, 100.002],
      currentPrice: 100.002,
      pctChangeSincePurchase: 0.00002,
      points: 3,
    });
    expect(issues).toEqual([]);
  });
});
