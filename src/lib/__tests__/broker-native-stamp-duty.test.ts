import { describe, it, expect } from "vitest";
import { inferSaxoCurrency } from "../saxo-fees";
import { attractsStampDuty, estimateTradeCosts } from "../trade-viability-gate";

describe("broker-native symbol currency + stamp duty", () => {
  it("maps MIC suffixes to the trade currency", () => {
    expect(inferSaxoCurrency("MKS:xlon")).toBe("GBP");
    expect(inferSaxoCurrency("AAPL:xnas")).toBe("USD");
    expect(inferSaxoCurrency("SAP:xetr")).toBe("EUR");
    expect(inferSaxoCurrency("NESN:xswx")).toBe("CHF");
  });

  it("still maps Yahoo-style suffixes", () => {
    expect(inferSaxoCurrency("MKS.L")).toBe("GBP");
    expect(inferSaxoCurrency("AAPL")).toBe("USD");
  });

  it("charges stamp duty on broker-native UK single shares", () => {
    expect(attractsStampDuty("MKS:xlon", "stock")).toBe(true);
    expect(attractsStampDuty("ISF:xlon", "etf")).toBe(false);
    expect(attractsStampDuty("AAPL:xnas", "stock")).toBe(false);
  });

  it("includes 50bps of stamp duty in the modelled buy cost", () => {
    const costs = estimateTradeCosts({
      symbol: "MKS:xlon", side: "buy", quantity: 1_000, price: 5, assetClass: "stock",
    });
    expect(costs.stampDutyBps).toBeCloseTo(50, 6);
    const sell = estimateTradeCosts({
      symbol: "MKS:xlon", side: "sell", quantity: 1_000, price: 5, assetClass: "stock",
    });
    expect(sell.stampDuty).toBe(0);
  });
});
