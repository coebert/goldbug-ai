import { describe, it, expect } from "vitest";
import {
  denormalizePriceToQuoteUnits,
  normalizeMarketPriceForTrading,
} from "@/lib/market-price-units";

describe("denormalizePriceToQuoteUnits", () => {
  it("converts GBP-normalised LSE stock prices back to pence", () => {
    // MKS quoted ~404p; our engine holds 4.04 GBP.
    expect(denormalizePriceToQuoteUnits("MKS:xlon", 4.0475)).toBeCloseTo(404.75, 6);
    expect(denormalizePriceToQuoteUnits("MKS.L", 4.0475)).toBeCloseTo(404.75, 6);
  });

  it("leaves GBP-quoted LSE tickers and non-LSE symbols alone", () => {
    expect(denormalizePriceToQuoteUnits("VUSA:xlon", 91.2)).toBe(91.2);
    expect(denormalizePriceToQuoteUnits("AAPL:xnas", 210.5)).toBe(210.5);
  });

  it("round-trips with the trading normaliser", () => {
    for (const sym of ["MKS.L", "HSBA:xlon", "VUSA.L", "AAPL"]) {
      const quote = 404.75;
      const base = normalizeMarketPriceForTrading(sym, quote);
      expect(denormalizePriceToQuoteUnits(sym, base)).toBeCloseTo(quote, 6);
    }
  });

  it("is safe on non-finite input", () => {
    expect(denormalizePriceToQuoteUnits("MKS.L", Number.NaN)).toBe(0);
  });
});
