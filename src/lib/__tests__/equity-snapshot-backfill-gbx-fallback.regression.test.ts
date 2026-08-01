// Regression: the equity-snapshot backfill used to look prices up with the
// broker-native symbol only ("MKS:xlon") while price_cache is keyed
// Yahoo-style ("MKS.L"). Every LSE row missed, fell back to avg_cost — which
// is stored in GBX (pence) — and the raw pence was added straight into a GBP
// total, inflating the real-money tile ~100x (GBP 817,118 instead of ~10,189).

import { describe, expect, it } from "vitest";
import { markHoldingsToMarket } from "../equity-snapshot-backfill";
import { priceSymbolVariants, resolvePriceSymbol } from "../price-symbol";

const HOLDINGS = [
  { portfolio_id: "p1", symbol: "MKS:xlon", quantity: 879, avg_cost: 404.1573, asset_class: "stock" },
  { portfolio_id: "p1", symbol: "HSBA:xlon", quantity: 175, avg_cost: 1557.4206, asset_class: "stock" },
  { portfolio_id: "p1", symbol: "ULVR:xlon", quantity: 22, avg_cost: 4942.8295, asset_class: "stock" },
  { portfolio_id: "p1", symbol: "TSCO:xlon", quantity: 160, avg_cost: 489.3925, asset_class: "stock" },
  { portfolio_id: "p1", symbol: "VMID:xlon", quantity: 4, avg_cost: 36.4425, asset_class: "etf" },
  { portfolio_id: "p1", symbol: "VUKE:xlon", quantity: 3, avg_cost: 46.34, asset_class: "etf" },
];

describe("symbol resolution", () => {
  it("maps MIC suffixes to price_cache keys", () => {
    expect(resolvePriceSymbol("MKS:xlon")).toBe("MKS.L");
    expect(resolvePriceSymbol("AAPL:xnas")).toBe("AAPL");
    expect(resolvePriceSymbol("SAP:xetr")).toBe("SAP.DE");
    expect(resolvePriceSymbol("VTI")).toBe("VTI");
  });

  it("offers both native and Yahoo variants", () => {
    expect(priceSymbolVariants("MKS:xlon")).toEqual(["MKS:XLON", "MKS.L"]);
  });
});

describe("markHoldingsToMarket — GBX never leaks into a GBP total", () => {
  it("resolves Yahoo-keyed prices for MIC-suffixed holdings", () => {
    const prices = new Map<string, number>([
      ["MKS.L", 403], ["HSBA.L", 1464], ["ULVR.L", 4729],
      ["TSCO.L", 489], ["VMID.L", 36.5], ["VUKE.L", 46.5],
    ]);
    const value = markHoldingsToMarket(HOLDINGS, prices);
    // 879*4.03 + 175*14.64 + 22*47.29 + 160*4.89 + 4*36.5 + 3*46.5
    expect(value).toBeCloseTo(8212.65, 1);
    expect(value).toBeLessThan(20_000);
  });

  it("normalises the avg_cost fallback when no price is cached", () => {
    const value = markHoldingsToMarket(HOLDINGS, new Map());
    // Cost basis in GBP, not the ~815,000 pence-as-pounds figure.
    expect(value).toBeGreaterThan(7_000);
    expect(value).toBeLessThan(12_000);
  });

  it("leaves GBP-quoted LSE ETFs and US symbols unscaled", () => {
    const value = markHoldingsToMarket(
      [
        { portfolio_id: "p1", symbol: "VUKE:xlon", quantity: 10, avg_cost: 46.34, asset_class: "etf" },
        { portfolio_id: "p1", symbol: "AAPL:xnas", quantity: 2, avg_cost: 342.87, asset_class: "stock" },
      ],
      new Map([["AAPL", 230]]),
    );
    expect(value).toBeCloseTo(10 * 46.34 + 2 * 230, 2);
  });
});

describe("markHoldingsToMarket — foreign currency", () => {
  it("converts USD positions into the GBP reporting currency", () => {
    const value = markHoldingsToMarket(
      [{ portfolio_id: "p1", symbol: "AAPL:xnas", quantity: 2, avg_cost: 342.87, instrument_ccy: "USD" }],
      new Map([["AAPL", 300]]),
      { baseCurrency: "GBP", fx: (from, to) => (from === "USD" && to === "GBP" ? 0.78 : null) },
    );
    expect(value).toBeCloseTo(2 * 300 * 0.78, 2);
  });

  it("falls back to 1:1 when no rate is available", () => {
    const value = markHoldingsToMarket(
      [{ portfolio_id: "p1", symbol: "AAPL:xnas", quantity: 2, avg_cost: 342.87, instrument_ccy: "USD" }],
      new Map([["AAPL", 300]]),
      { baseCurrency: "GBP", fx: () => null },
    );
    expect(value).toBeCloseTo(600, 2);
  });

  it("does not double-convert GBX-quoted LSE rows", () => {
    const value = markHoldingsToMarket(
      [{ portfolio_id: "p1", symbol: "MKS:xlon", quantity: 100, avg_cost: 400, instrument_ccy: "GBX" }],
      new Map([["MKS.L", 400]]),
      { baseCurrency: "GBP", fx: () => 0.5 },
    );
    expect(value).toBeCloseTo(400, 2);
  });
});
