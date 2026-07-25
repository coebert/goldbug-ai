import { describe, it, expect } from "vitest";
import { valueHoldings, type FxLookup } from "@/lib/multi-ccy-holdings";

// Deterministic FX table so tests don't depend on the network.
const rates: Record<string, number> = {
  USDGBP: 0.8,
  EURGBP: 0.85,
  GBPUSD: 1.25,
  GBPEUR: 1.1765,
};
const fx: FxLookup = (from, to) => {
  const k = `${from}${to}`;
  if (from === to) return 1;
  return rates[k] ?? Number.NaN;
};

describe("valueHoldings", () => {
  it("returns pure holdings + cash when everything is already in base ccy", () => {
    const v = valueHoldings(
      [{ symbol: "VOD.L", quantity: 100, price: 5, instrument_ccy: "GBP" }],
      { GBP: 1000 },
      "GBP",
      fx,
    );
    expect(v.holdingsBaseCcy).toBe(500);
    expect(v.cashBaseCcy).toBe(1000);
    expect(v.totalBaseCcy).toBe(1500);
    expect(v.usedStaleRate).toBe(false);
    expect(v.byCurrency.GBP).toEqual({ holdings: 500, cash: 1000, total: 1500 });
  });

  it("converts USD holdings and cash into GBP using the FX lookup", () => {
    const v = valueHoldings(
      [{ symbol: "AAPL", quantity: 10, price: 200, instrument_ccy: "USD" }], // 2000 USD
      { GBP: 500, USD: 300 },
      "GBP",
      fx,
    );
    expect(v.byCurrency.USD).toEqual({ holdings: 2000, cash: 300, total: 2300 });
    expect(v.byCurrency.GBP).toEqual({ holdings: 0, cash: 500, total: 500 });
    // 2000 USD → 1600 GBP; 300 USD → 240 GBP; + 500 GBP cash = 2340 GBP
    expect(v.holdingsBaseCcy).toBe(1600);
    expect(v.cashBaseCcy).toBeCloseTo(740, 6);
    expect(v.totalBaseCcy).toBeCloseTo(2340, 6);
  });

  it("mixes three currencies in one valuation", () => {
    const v = valueHoldings(
      [
        { symbol: "AAPL", quantity: 1, price: 100, instrument_ccy: "USD" },
        { symbol: "SAP",  quantity: 2, price: 50,  instrument_ccy: "EUR" },
        { symbol: "VOD",  quantity: 10, price: 5,  instrument_ccy: "GBP" },
      ],
      { GBP: 100 },
      "GBP",
      fx,
    );
    // 100 USD → 80 GBP;  100 EUR → 85 GBP;  50 GBP + 100 cash = 315 GBP total
    expect(v.totalBaseCcy).toBeCloseTo(315, 6);
    expect(v.usedStaleRate).toBe(false);
  });

  it("flags stale when a rate is missing but still returns a (identity-fallback) number", () => {
    const v = valueHoldings(
      [{ symbol: "TOYOTA", quantity: 1, price: 1000, instrument_ccy: "JPY" }],
      {},
      "GBP",
      fx, // no JPYGBP in table
    );
    expect(v.usedStaleRate).toBe(true);
    expect(v.staleRatePairs).toContain("JPYGBP");
    expect(v.totalBaseCcy).toBe(1000); // identity fallback
  });

  it("respects an isRateStale override even when the numeric rate is fine", () => {
    const v = valueHoldings(
      [{ symbol: "AAPL", quantity: 1, price: 100, instrument_ccy: "USD" }],
      {},
      "GBP",
      fx,
      (from, to) => from === "USD" && to === "GBP", // pretend USDGBP is stale
    );
    expect(v.holdingsBaseCcy).toBe(80); // still uses the rate
    expect(v.usedStaleRate).toBe(true);
    expect(v.staleRatePairs).toContain("USDGBP");
  });

  it("skips holdings with non-finite quantity or price without crashing", () => {
    const v = valueHoldings(
      [
        { symbol: "BAD", quantity: Number.NaN, price: 10, instrument_ccy: "GBP" },
        { symbol: "OK",  quantity: 2,          price: 5,  instrument_ccy: "GBP" },
      ],
      { GBP: 0 },
      "GBP",
      fx,
    );
    expect(v.totalBaseCcy).toBe(10);
  });
});
