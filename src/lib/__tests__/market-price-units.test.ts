import { describe, expect, it } from "vitest";

import {
  isLsePenceQuoted,
  marketQuoteCurrency,
  normalizeMarketPriceForTrading,
} from "@/lib/market-price-units";

describe("market price unit normalization", () => {
  it("converts London-listed GBX quotes into GBP trading prices", () => {
    expect(isLsePenceQuoted("ULVR.L")).toBe(true);
    expect(marketQuoteCurrency("ULVR.L")).toBe("GBX");
    expect(normalizeMarketPriceForTrading("ULVR.L", 4375)).toBe(43.75);
  });

  it("leaves non-LSE symbols unchanged", () => {
    expect(isLsePenceQuoted("AAPL")).toBe(false);
    expect(marketQuoteCurrency("AAPL")).toBeNull();
    expect(normalizeMarketPriceForTrading("AAPL", 218.4)).toBe(218.4);
  });

  it("returns zero for non-finite prices so order sizing cannot emit NaN", () => {
    expect(normalizeMarketPriceForTrading("ULVR.L", Number.NaN)).toBe(0);
    expect(normalizeMarketPriceForTrading("AAPL", Number.POSITIVE_INFINITY)).toBe(0);
  });
});