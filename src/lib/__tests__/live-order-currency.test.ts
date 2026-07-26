// Regression tests for the instrument_ccy stamping used on every live_orders
// insert. The DB now enforces NOT NULL + `^[A-Z]{3}$` CHECK on this column
// (migration: live_orders_instrument_ccy_iso4217), so a broken resolver
// crashes the executor instead of silently mis-labelling USD orders as GBP
// and getting them rejected by Saxo as InsufficientCash.

import { describe, it, expect } from "vitest";
import {
  normaliseCcy,
  resolveOrderCurrency,
  resolveOrderCurrencies,
} from "@/lib/live-order-currency";

describe("normaliseCcy", () => {
  it("accepts a valid ISO-4217 code and uppercases it", () => {
    expect(normaliseCcy("usd")).toBe("USD");
    expect(normaliseCcy("  EUR  ")).toBe("EUR");
  });
  it("rejects empty / null / non-3-letter / non-alpha", () => {
    expect(normaliseCcy(null)).toBeNull();
    expect(normaliseCcy(undefined)).toBeNull();
    expect(normaliseCcy("")).toBeNull();
    expect(normaliseCcy("US")).toBeNull();
    expect(normaliseCcy("USDX")).toBeNull();
    expect(normaliseCcy("US1")).toBeNull();
    expect(normaliseCcy("GBp")).toBeNull(); // lowercase 'p' — LSE pence pseudo-code, not ISO-4217
  });
});

describe("resolveOrderCurrency — priority chain", () => {
  const cache = new Map<string, string | null | undefined>([
    ["V", "USD"],
    ["JNJ", "USD"],
    ["SPY", "USD"],
    ["ULVR.L", "GBP"],
    ["SAP.DE", "EUR"],
  ]);

  it("caller hint wins over cache and portfolio base", () => {
    expect(
      resolveOrderCurrency(
        { symbol: "V", instrument_ccy: "USD" },
        { cache, portfolioCurrency: "GBP" },
      ),
    ).toBe("USD");
  });

  it("falls back to saxo_instrument_cache when caller omits the hint (never defaults to GBP for a USD name)", () => {
    // Reproduces the exact bug: EUR-cash portfolio, no caller hint, V is USD in the cache.
    // Old executor stamped GBP from the column default → Saxo returned InsufficientCash.
    expect(
      resolveOrderCurrency(
        { symbol: "V" },
        { cache, portfolioCurrency: "EUR" },
      ),
    ).toBe("USD");
    expect(
      resolveOrderCurrency(
        { symbol: "JNJ" },
        { cache, portfolioCurrency: "EUR" },
      ),
    ).toBe("USD");
  });

  it("falls back to portfolio base only when the symbol is unknown in cache", () => {
    expect(
      resolveOrderCurrency(
        { symbol: "UNKNOWN" },
        { cache, portfolioCurrency: "EUR" },
      ),
    ).toBe("EUR");
  });

  it("normalises cache values (uppercase / trims)", () => {
    const messy = new Map<string, string | null | undefined>([
      ["AAPL", " usd "],
    ]);
    expect(
      resolveOrderCurrency(
        { symbol: "AAPL" },
        { cache: messy, portfolioCurrency: "GBP" },
      ),
    ).toBe("USD");
  });

  it("skips invalid cache values and continues down the chain", () => {
    const broken = new Map<string, string | null | undefined>([
      ["AAPL", "US"], // too short — should be ignored
    ]);
    expect(
      resolveOrderCurrency(
        { symbol: "AAPL" },
        { cache: broken, portfolioCurrency: "EUR" },
      ),
    ).toBe("EUR");
  });

  it("throws (never returns a fake code) when no valid source exists", () => {
    expect(() =>
      resolveOrderCurrency(
        { symbol: "AAPL" },
        { portfolioCurrency: "??" },
      ),
    ).toThrow(/Unable to resolve instrument currency for AAPL/);
  });

  it("ignores a caller hint that is not ISO-4217 and falls through to cache", () => {
    // Guards against upstream bugs that pass e.g. "GBp" (pence pseudo-code).
    expect(
      resolveOrderCurrency(
        { symbol: "ULVR.L", instrument_ccy: "GBp" },
        { cache, portfolioCurrency: "EUR" },
      ),
    ).toBe("GBP");
  });
});

describe("resolveOrderCurrencies — batch stamping matches the executor's insert payload", () => {
  it("stamps each symbol with its true currency in a mixed-market batch (no GBP default leaks)", () => {
    const cache = new Map<string, string | null | undefined>([
      ["V", "USD"],
      ["JNJ", "USD"],
      ["SPY", "USD"],
      ["ULVR.L", "GBP"],
      ["SAP.DE", "EUR"],
    ]);
    const batch = [
      { symbol: "V", side: "buy" as const, quantity: 235, price: 200 },
      { symbol: "JNJ", side: "buy" as const, quantity: 318, price: 160 },
      { symbol: "SPY", side: "buy" as const, quantity: 107, price: 500 },
      { symbol: "ULVR.L", side: "buy" as const, quantity: 7, price: 4200 },
      { symbol: "SAP.DE", side: "buy" as const, quantity: 40, price: 180 },
    ];
    const stamped = resolveOrderCurrencies(batch, {
      cache,
      portfolioCurrency: "EUR", // High-risk sim portfolio base
    });
    expect(Object.fromEntries(stamped)).toEqual({
      V: "USD",
      JNJ: "USD",
      SPY: "USD",
      "ULVR.L": "GBP",
      "SAP.DE": "EUR",
    });
    // Every stamped value must satisfy the DB CHECK constraint.
    for (const v of stamped.values()) {
      expect(v).toMatch(/^[A-Z]{3}$/);
    }
  });

  it("deduplicates repeated symbols in the batch", () => {
    const stamped = resolveOrderCurrencies(
      [
        { symbol: "V", side: "buy" as const, quantity: 1, price: 1 },
        { symbol: "V", side: "sell" as const, quantity: 1, price: 1 },
      ],
      { cache: new Map([["V", "USD"]]), portfolioCurrency: "EUR" },
    );
    expect(stamped.size).toBe(1);
    expect(stamped.get("V")).toBe("USD");
  });
});
