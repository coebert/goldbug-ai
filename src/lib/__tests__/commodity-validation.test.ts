import { describe, expect, it } from "vitest";
import { classifyCommodityProposal } from "../commodity-validation.server";

describe("classifyCommodityProposal", () => {
  it("passes through non-commodity symbols without validation", () => {
    const r = classifyCommodityProposal({
      symbol: "AAPL",
      side: "buy",
      price: 200,
      hasFeatureRow: true,
    });
    expect(r.needsValidation).toBe(false);
    expect(r.failFast).toBeNull();
  });

  it("does not validate commodity sells so exits are never trapped", () => {
    const r = classifyCommodityProposal({
      symbol: "SGLN.L",
      side: "sell",
      price: 60,
      hasFeatureRow: false,
    });
    expect(r.needsValidation).toBe(false);
    expect(r.failFast).toBeNull();
    expect(r.meta?.asset_class).toBe("commodity");
  });

  it("fails fast when a commodity buy has no live price", () => {
    const r = classifyCommodityProposal({
      symbol: "IAU",
      side: "buy",
      price: 0,
      hasFeatureRow: true,
    });
    expect(r.needsValidation).toBe(true);
    expect(r.failFast).toMatch(/no live price/);
  });

  it("fails fast when the sizing feature row is missing", () => {
    const r = classifyCommodityProposal({
      symbol: "SLV",
      side: "buy",
      price: 25,
      hasFeatureRow: false,
    });
    expect(r.failFast).toMatch(/feature row/);
  });

  it("passes classification for a well-formed commodity buy", () => {
    const r = classifyCommodityProposal({
      symbol: "SGLN.L",
      side: "buy",
      price: 60,
      hasFeatureRow: true,
    });
    expect(r.needsValidation).toBe(true);
    expect(r.failFast).toBeNull();
  });

  it("ignores unknown symbols entirely", () => {
    const r = classifyCommodityProposal({
      symbol: "NOT.A.REAL",
      side: "buy",
      price: 10,
      hasFeatureRow: true,
    });
    expect(r.needsValidation).toBe(false);
    expect(r.meta).toBeNull();
  });
});
