import { describe, it, expect } from "vitest";
import { nativeQuotePrice } from "@/lib/market-price-units";

// Every broker-bound limit/stop price must leave in the instrument's native
// quote units. LSE common stocks are pence-quoted, so a GBP-scaled price sits
// ~100x below the market and Saxo rejects it as "Price exceeds aggressive
// tolerance" — which is what blocked the MKS sell.
describe("nativeQuotePrice", () => {
  it("routes LSE stocks in pence from the symbol alone", () => {
    expect(nativeQuotePrice("MKS.L", 4.0475)).toBeCloseTo(404.75, 6);
    expect(nativeQuotePrice("HSBA:xlon", 15.5519, "GBP")).toBeCloseTo(1555.19, 4);
  });

  it("routes in pence when only the broker says GBX", () => {
    // Bare ticker with no venue suffix — the symbol rule can't classify it.
    expect(nativeQuotePrice("MKS", 4.0475, "GBX")).toBeCloseTo(404.75, 6);
    expect(nativeQuotePrice("BP", 3.85, "gbx")).toBeCloseTo(385, 6);
  });

  it("never double-scales when both signals agree", () => {
    expect(nativeQuotePrice("MKS:xlon", 4.0475, "GBX")).toBeCloseTo(404.75, 6);
  });

  it("leaves GBP-quoted LSE ETFs and non-LSE names alone", () => {
    expect(nativeQuotePrice("VUSA.L", 91.2, "GBP")).toBe(91.2);
    expect(nativeQuotePrice("VMID:xlon", 36.44, "GBP")).toBe(36.44);
    expect(nativeQuotePrice("AAPL:xnas", 210.5, "USD")).toBe(210.5);
    expect(nativeQuotePrice("SAP.DE", 240.1, "EUR")).toBe(240.1);
  });

  it("is safe on non-finite input and missing currency", () => {
    expect(nativeQuotePrice("MKS.L", Number.NaN, null)).toBe(0);
    expect(nativeQuotePrice("AAPL", 210.5, undefined)).toBe(210.5);
  });
});
