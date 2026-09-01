import { describe, it, expect } from "vitest";
import { resolvePriceSymbol, priceSymbolVariants } from "@/lib/price-symbol";
describe("retired tickers", () => {
  it("maps retired crypto lines to live successors", () => {
    expect(resolvePriceSymbol("ETHE.DE")).toBe("ZETH.DE");
    expect(resolvePriceSymbol("VBTC.L")).toBe("BTCW.L");
    expect(resolvePriceSymbol("VBTC:xlon")).toBe("BTCW.L");
    expect(priceSymbolVariants("ETHE.DE")).toContain("ZETH.DE");
  });
  it("leaves live symbols untouched", () => {
    expect(resolvePriceSymbol("MKS:xlon")).toBe("MKS.L");
    expect(resolvePriceSymbol("AAPL:xnas")).toBe("AAPL");
  });
});
