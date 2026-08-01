import { describe, expect, it } from "vitest";
import { resolvePriceSymbol, priceSymbolVariants } from "../price-symbol";
import { normalizeMarketPriceForTrading } from "../market-price-units";

// The engine fetches quotes for broker-native holding symbols. Requesting
// "MKS:xlon" from the price provider 404s, leaving the holding unpriced and
// valued off cost basis — which is what fabricated the 76.9% drawdown halt.
describe("broker-native symbols resolve to a fetchable price key", () => {
  it("maps LSE and US broker symbols to canonical price keys", () => {
    expect(resolvePriceSymbol("MKS:xlon")).toBe("MKS.L");
    expect(resolvePriceSymbol("HSBA:xlon")).toBe("HSBA.L");
    expect(resolvePriceSymbol("AAPL:xnas")).toBe("AAPL");
  });

  it("normalizes the LSE quote exactly once, via the canonical key", () => {
    const canonical = resolvePriceSymbol("MKS:xlon");
    expect(normalizeMarketPriceForTrading(canonical, 405.1)).toBeCloseTo(4.051, 6);
  });

  it("publishes a quote under every spelling the lookup may use", () => {
    const sym = "MKS:xlon";
    const canonical = resolvePriceSymbol(sym);
    const map = new Map<string, number>();
    for (const key of new Set([sym, canonical, ...priceSymbolVariants(sym)])) {
      map.set(key, 4.051);
      map.set(key.toUpperCase(), 4.051);
      map.set(key.toLowerCase(), 4.051);
    }
    for (const probe of ["MKS:xlon", "MKS:XLON", "MKS.L", "mks.l"]) {
      expect(map.get(probe)).toBe(4.051);
    }
  });
});
