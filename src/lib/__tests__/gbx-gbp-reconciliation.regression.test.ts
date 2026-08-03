// Regression suite for the GBX/GBP unit and currency faults that reached
// production twice:
//
//   1. `live_fills` rows written with `fill_price: 0` and a hardcoded
//      `currency: "GBP"` (Saxo /hist, presumed-fill and position-fallback
//      reconcile paths).
//   2. LSE pence quotes stored as if they were pounds, inflating cost basis
//      and notional 100x (~£8.44m of phantom notional across 18 legacy rows)
//      and pinning every LSE line to a fixed ≈ -99% return.
//   3. The mirror fault: normalising an already-normalised cost basis a
//      second time (MKS £4.04 -> "£0.04", +9900% gains).
//
// Every assertion here is pinned to a real symbol from the ledger so a future
// reconciliation code path cannot reintroduce either direction of the bug.

import { describe, it, expect } from "vitest";
import {
  resolveFillPrice,
  resolveFillCurrency,
  resolveFillRecord,
} from "../fill-record";
import {
  isLseGbxDisplayQuoted,
  normalizeLseDisplayPriceToBase,
  normalizeMarketPriceForTrading,
  holdingAvgCostBase,
  marketQuoteCurrency,
} from "../market-price-units";

/** Symbol, venue close in its native quote unit, expected pounds. */
const PENCE_QUOTED: Array<[string, number, number]> = [
  ["HSBA.L", 1548.400024, 15.48400024],
  ["MKS.L", 405.399994, 4.05399994],
  ["TSCO.L", 501.799988, 5.01799988],
  ["ULVR.L", 4627, 46.27],
  ["SGLN.L", 5879, 58.79],
  ["ISF.L", 1058.599976, 10.58599976],
];

/** LSE tickers the provider quotes in pounds already — must pass through. */
const POUND_QUOTED: Array<[string, number]> = [
  ["VUKE.L", 46.505001],
  ["VMID.L", 36.439999],
  ["VWRL.L", 105.62],
];

describe("LSE pence-to-pound normalisation", () => {
  it.each(PENCE_QUOTED)("%s pence quote converts to pounds", (symbol, raw, pounds) => {
    expect(isLseGbxDisplayQuoted(symbol)).toBe(true);
    expect(marketQuoteCurrency(symbol)).toBe("GBX");
    expect(normalizeLseDisplayPriceToBase(symbol, raw)).toBeCloseTo(pounds, 8);
    // Order sizing must agree with display, or the ledger and the tiles drift.
    expect(normalizeMarketPriceForTrading(symbol, raw)).toBeCloseTo(pounds, 8);
  });

  it.each(POUND_QUOTED)("%s is already in pounds and is never divided", (symbol, raw) => {
    expect(isLseGbxDisplayQuoted(symbol)).toBe(false);
    expect(marketQuoteCurrency(symbol)).toBeNull();
    expect(normalizeLseDisplayPriceToBase(symbol, raw)).toBe(raw);
    expect(normalizeMarketPriceForTrading(symbol, raw)).toBe(raw);
  });

  it("applies the same rule to the :XLON broker-native form", () => {
    expect(normalizeLseDisplayPriceToBase("MKS:XLON", 405.4)).toBeCloseTo(4.054, 8);
    expect(normalizeLseDisplayPriceToBase("VUKE:XLON", 46.5)).toBe(46.5);
  });

  it("never touches non-LSE listings", () => {
    for (const [symbol, price] of [["AAPL", 213.5], ["AAPL:xnas", 213.5], ["V", 341.2]] as const) {
      expect(normalizeLseDisplayPriceToBase(symbol, price)).toBe(price);
      expect(normalizeMarketPriceForTrading(symbol, price)).toBe(price);
    }
  });

  it("does not widen the pound allowlist to 'all LSE ETFs' (the 100x inflation regression)", () => {
    // iShares ETFs quote in pence despite being ETFs. Treating ETF status as
    // a pound signal read a ~£92k sim portfolio as ~£9.2m.
    for (const etf of ["ISF.L", "SGLN.L", "IUKD.L", "IWDG.L"]) {
      expect(isLseGbxDisplayQuoted(etf, "etf")).toBe(true);
      expect(normalizeLseDisplayPriceToBase(etf, 1000, "etf")).toBe(10);
    }
  });

  it("keeps notional sane: 2266 x ISF at 1058.6p is ~£23.9k, not ~£2.4m", () => {
    const notional = 2266 * normalizeLseDisplayPriceToBase("ISF.L", 1058.599976);
    expect(notional).toBeGreaterThan(23_000);
    expect(notional).toBeLessThan(25_000);
  });

  it("holdings.avg_cost is already base — reads must not divide again", () => {
    // Stored 4.0403 GBP. A second ÷100 produced the +9900% tile.
    expect(holdingAvgCostBase("MKS.L", 4.0403)).toBeCloseTo(4.0403, 8);
    expect(holdingAvgCostBase("MKS.L", "4.0403")).toBeCloseTo(4.0403, 8);
    expect(holdingAvgCostBase("HSBA.L", null)).toBe(0);
    const gain = (normalizeLseDisplayPriceToBase("MKS.L", 409.5) / holdingAvgCostBase("MKS.L", 4.0403) - 1) * 100;
    expect(Math.abs(gain)).toBeLessThan(10);
  });
});

describe("fill currency resolution — GBX is a quote unit, never a currency", () => {
  it.each(["GBX", "gbx", " GbX ", "ZAC", "ILA", "GBP0"])(
    "rejects %s from the order's instrument_ccy",
    (junk) => {
      expect(
        resolveFillCurrency({ symbol: "HSBA.L", orderCcy: junk, portfolioCurrency: "GBP" }),
      ).toBe("GBP");
    },
  );

  it("rejects a pence unit reported by the broker and falls to the venue rule", () => {
    expect(
      resolveFillCurrency({ symbol: "SGLN.L", orderCcy: null, brokerCcy: "GBX", portfolioCurrency: "GBP" }),
    ).toBe("GBP");
  });

  it("never stamps a US execution as GBP just because the portfolio is GBP", () => {
    for (const symbol of ["AAPL", "AAPL:xnas", "V", "JNJ"]) {
      expect(
        resolveFillCurrency({ symbol, orderCcy: null, brokerCcy: null, portfolioCurrency: "GBP" }),
      ).toBe("USD");
    }
  });

  it("maps every LSE form to GBP when no explicit currency exists", () => {
    for (const symbol of ["HSBA.L", "MKS.L", "VUKE.L", "MKS:XLON"]) {
      expect(resolveFillCurrency({ symbol, portfolioCurrency: "EUR" })).toBe("GBP");
    }
  });

  it("always returns an ISO-4217 code, whatever the inputs", () => {
    for (const symbol of ["HSBA.L", "AAPL", "SAP:xetr", "SGLN.L"]) {
      const ccy = resolveFillCurrency({ symbol, orderCcy: "??", brokerCcy: "", portfolioCurrency: null });
      expect(ccy).toMatch(/^[A-Z]{3}$/);
      expect(["GBX", "ZAC", "ILA"]).not.toContain(ccy);
    }
  });
});

describe("fill price resolution — a zero is never a fill", () => {
  const zeroish = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, "", "abc"];

  it("returns null instead of booking a zero for every unusable candidate set", () => {
    for (const v of zeroish) {
      expect(resolveFillPrice("HSBA.L", [{ source: "hist.avgPrice", value: v as never }])).toBeNull();
    }
    expect(
      resolveFillPrice("HSBA.L", zeroish.map((value, i) => ({ source: `c${i}`, value: value as never }))),
    ).toBeNull();
  });

  it.each([
    ["saxo /hist avgPrice missing", "hist.avgPrice"],
    ["presumed fill, price_cache empty", "price_cache.close"],
    ["position fallback, no currency", "position.openPrice"],
  ])("%s -> resolveFillRecord returns null so the caller skips the insert", (_label, source) => {
    expect(
      resolveFillRecord({
        symbol: "SGLN.L",
        candidates: [{ source, value: 0 }],
        portfolioCurrency: "GBP",
      }),
    ).toBeNull();
  });

  it("falls through to the next source and flags the fallback", () => {
    const r = resolveFillRecord({
      symbol: "MKS.L",
      candidates: [
        { source: "broker.fillPrice", value: 0 },
        { source: "order.limitPrice", value: null },
        { source: "price_cache.close", value: 405.4 },
      ],
      portfolioCurrency: "GBP",
    });
    expect(r).not.toBeNull();
    expect(r!.fillPrice).toBeCloseTo(4.054, 8);
    expect(r!.currency).toBe("GBP");
    expect(r!.priceSource).toBe("price_cache.close");
    expect(r!.fallback).toBe(true);
  });

  it("respects raw:false — a price already in base is not re-divided", () => {
    const r = resolveFillRecord({
      symbol: "HSBA.L",
      candidates: [{ source: "ledger.basePrice", value: 15.518, raw: false }],
      portfolioCurrency: "GBP",
    });
    expect(r!.fillPrice).toBeCloseTo(15.518, 8);
  });
});

describe("end-to-end reconcile records match the repaired ledger", () => {
  const cases: Array<{
    symbol: string;
    rawQuote: number;
    quantity: number;
    orderCcy: string | null;
    brokerCcy: string | null;
    expectPrice: number;
    expectCcy: string;
  }> = [
    { symbol: "HSBA.L", rawQuote: 1551.8, quantity: 102, orderCcy: null, brokerCcy: "GBX", expectPrice: 15.518, expectCcy: "GBP" },
    { symbol: "SGLN.L", rawQuote: 5841, quantity: 892, orderCcy: "GBX", brokerCcy: null, expectPrice: 58.41, expectCcy: "GBP" },
    { symbol: "VUKE.L", rawQuote: 46.505001, quantity: 3, orderCcy: null, brokerCcy: null, expectPrice: 46.505001, expectCcy: "GBP" },
    { symbol: "AAPL", rawQuote: 213.5, quantity: 2, orderCcy: "USD", brokerCcy: null, expectPrice: 213.5, expectCcy: "USD" },
    { symbol: "V", rawQuote: 341.2, quantity: 1, orderCcy: null, brokerCcy: null, expectPrice: 341.2, expectCcy: "USD" },
  ];

  it.each(cases)("$symbol books $expectPrice $expectCcy", (c) => {
    const r = resolveFillRecord({
      symbol: c.symbol,
      candidates: [{ source: "broker.fillPrice", value: c.rawQuote }],
      orderCcy: c.orderCcy,
      brokerCcy: c.brokerCcy,
      portfolioCurrency: "GBP",
    });
    expect(r).not.toBeNull();
    expect(r!.fillPrice).toBeCloseTo(c.expectPrice, 6);
    expect(r!.currency).toBe(c.expectCcy);
    expect(r!.fillPrice).toBeGreaterThan(0);
    // Notional stays within an order of magnitude of the pounds value: the
    // 100x fault always shows up here first.
    expect(r!.fillPrice * c.quantity).toBeLessThan(c.rawQuote * c.quantity);
  });

  it("is idempotent — re-running reconciliation on a stored fill does not rescale it", () => {
    const first = resolveFillRecord({
      symbol: "TSCO.L",
      candidates: [{ source: "broker.fillPrice", value: 489.5 }],
      portfolioCurrency: "GBP",
    })!;
    const second = resolveFillRecord({
      symbol: "TSCO.L",
      candidates: [{ source: "live_fills.fill_price", value: first.fillPrice, raw: false }],
      orderCcy: first.currency,
      portfolioCurrency: "GBP",
    })!;
    expect(second.fillPrice).toBeCloseTo(first.fillPrice, 8);
    expect(second.currency).toBe(first.currency);
  });
});
