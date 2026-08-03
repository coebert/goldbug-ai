import { describe, it, expect } from "vitest";
import {
  resolveFillPrice,
  resolveFillCurrency,
  resolveFillRecord,
} from "@/lib/fill-record";

describe("resolveFillPrice", () => {
  it("takes the first positive candidate", () => {
    const r = resolveFillPrice("AAPL", [
      { source: "broker", value: 305.565, raw: false },
      { source: "limit", value: 300, raw: false },
    ]);
    expect(r).toEqual({ fillPrice: 305.565, source: "broker", fallback: false });
  });

  it("falls through zero, null, NaN and negative candidates", () => {
    const r = resolveFillPrice("AAPL", [
      { source: "broker", value: 0, raw: false },
      { source: "null", value: null, raw: false },
      { source: "nan", value: Number.NaN, raw: false },
      { source: "neg", value: -5, raw: false },
      { source: "limit", value: 305.565002, raw: false },
    ]);
    expect(r?.source).toBe("limit");
    expect(r?.fallback).toBe(true);
    expect(r?.fillPrice).toBeCloseTo(305.565002, 6);
  });

  it("returns null when nothing is usable — never a zero fill", () => {
    expect(
      resolveFillPrice("AAPL", [
        { source: "a", value: 0 },
        { source: "b", value: undefined },
      ]),
    ).toBeNull();
    expect(resolveFillPrice("AAPL", [])).toBeNull();
  });

  it("coerces numeric strings from the database", () => {
    expect(resolveFillPrice("AAPL", [{ source: "db", value: "305.565", raw: false }])?.fillPrice)
      .toBeCloseTo(305.565, 6);
  });

  it("converts LSE pence quotes into pounds for raw candidates", () => {
    const r = resolveFillPrice("ULVR.L", [{ source: "price_cache", value: 4620 }]);
    expect(r?.fillPrice).toBeCloseTo(46.2, 6);
  });

  it("does not re-divide a price already in base currency", () => {
    const r = resolveFillPrice("ULVR.L", [{ source: "broker", value: 46.2, raw: false }]);
    expect(r?.fillPrice).toBeCloseTo(46.2, 6);
  });

  it("leaves US symbols untouched even when marked raw", () => {
    expect(resolveFillPrice("AAPL", [{ source: "cache", value: 305.56 }])?.fillPrice)
      .toBeCloseTo(305.56, 6);
  });
});

describe("resolveFillCurrency", () => {
  it("prefers the order's instrument_ccy", () => {
    expect(
      resolveFillCurrency({ symbol: "AAPL", orderCcy: "usd", portfolioCurrency: "GBP" }),
    ).toBe("USD");
  });

  it("uses the broker-reported currency when the order has none", () => {
    expect(
      resolveFillCurrency({ symbol: "AAPL", orderCcy: null, brokerCcy: "USD", portfolioCurrency: "GBP" }),
    ).toBe("USD");
  });

  it("ignores non-ISO junk and falls through", () => {
    expect(
      resolveFillCurrency({ symbol: "AAPL", orderCcy: "GBX", brokerCcy: "", portfolioCurrency: "GBP" }),
    ).toBe("USD");
  });

  it("falls back to the venue rule — US listings are USD, not GBP", () => {
    expect(resolveFillCurrency({ symbol: "AAPL", portfolioCurrency: "GBP" })).toBe("USD");
    expect(resolveFillCurrency({ symbol: "JNJ", portfolioCurrency: "GBP" })).toBe("USD");
  });

  it("maps LSE listings to GBP", () => {
    expect(resolveFillCurrency({ symbol: "ULVR.L", portfolioCurrency: "GBP" })).toBe("GBP");
    expect(resolveFillCurrency({ symbol: "SGLN.L", portfolioCurrency: "USD" })).toBe("GBP");
  });

  it("always returns a 3-letter ISO code", () => {
    for (const sym of ["AAPL", "ULVR.L", "V", "SGLN.L", "VMID.L"]) {
      expect(resolveFillCurrency({ symbol: sym, portfolioCurrency: "GBP" })).toMatch(/^[A-Z]{3}$/);
    }
  });
});

describe("resolveFillRecord", () => {
  it("reproduces the correct AAPL sell record", () => {
    const rec = resolveFillRecord({
      symbol: "AAPL",
      orderCcy: "USD",
      candidates: [
        { source: "saxo_hist", value: null, raw: false },
        { source: "order_limit_price", value: 305.565002, raw: false },
      ],
      portfolioCurrency: "GBP",
    });
    expect(rec).toEqual({
      fillPrice: 305.565002,
      currency: "USD",
      priceSource: "order_limit_price",
      fallback: true,
    });
  });

  it("returns null rather than booking a zero-price fill", () => {
    expect(
      resolveFillRecord({
        symbol: "AAPL",
        orderCcy: "USD",
        candidates: [{ source: "saxo_hist", value: 0 }, { source: "limit", value: null }],
        portfolioCurrency: "GBP",
      }),
    ).toBeNull();
  });

  it("marks non-fallback when the primary source was used", () => {
    const rec = resolveFillRecord({
      symbol: "V",
      orderCcy: "USD",
      candidates: [{ source: "saxo_hist", value: 291.4, raw: false }],
      portfolioCurrency: "GBP",
    });
    expect(rec?.fallback).toBe(false);
    expect(rec?.currency).toBe("USD");
  });
});
