import { describe, expect, it } from "vitest";
import { isBrokerRoutable } from "../saxo-prices.server";

describe("isBrokerRoutable", () => {
  it("accepts cash-equity tickers in every spelling we store", () => {
    for (const s of ["AAPL", "MKS.L", "VUSA:xlon", "ZETH.DE"]) {
      expect(isBrokerRoutable(s)).toBe(true);
    }
  });

  it("rejects symbols Saxo can never resolve, so we skip the round-trip", () => {
    for (const s of ["GBPUSD", "GBPUSD=X", "^FTSE", "CL=F", "", "  "]) {
      expect(isBrokerRoutable(s)).toBe(false);
    }
  });
});
