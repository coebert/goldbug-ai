// The fill-unit bug: the live executor booked Saxo's raw `avgFillPrice`
// straight into `live_fills`, while the order-reconcile path ran the same
// number through `resolveFillRecord`. For LSE common stocks Saxo quotes in
// GBX, so the same instrument landed in the ledger in two different units
// (HSBA at 1556.20 alongside 15.52) and every cost-basis / realised-PnL
// figure built on top of it was wrong.
//
// Both write paths must now agree, symbol for symbol. This suite locks that
// agreement across every writer, symbol dialect, share granularity and
// currency the app can actually see, so a new broker route or a new venue
// cannot quietly reintroduce a mixed-unit ledger.

import { describe, it, expect } from "vitest";
import { resolveFillRecord, resolveFillCurrency } from "../fill-record";

/** The live executor: Saxo hands back a raw venue quote (may be GBX). */
function bookExecutor(
  symbol: string,
  brokerPrice: number | string | null,
  opts: { orderCcy?: string | null; portfolioCurrency?: string } = {},
) {
  return resolveFillRecord({
    symbol,
    candidates: [{ source: "broker_avg_fill_price", value: brokerPrice, raw: true }],
    orderCcy: opts.orderCcy ?? null,
    portfolioCurrency: opts.portfolioCurrency ?? "GBP",
  });
}

/** Reconcile via Saxo /hist: `hist.avgPrice`, falling back to the limit price. */
function bookHist(
  symbol: string,
  histPrice: number | null,
  limitPrice: number | null = null,
  opts: { orderCcy?: string | null; portfolioCurrency?: string } = {},
) {
  return resolveFillRecord({
    symbol,
    candidates: [
      { source: "saxo_hist_avg_price", value: histPrice, raw: true },
      { source: "order_limit_price", value: limitPrice, raw: false },
    ],
    orderCcy: opts.orderCcy ?? null,
    portfolioCurrency: opts.portfolioCurrency ?? "GBP",
  });
}

/** Reconcile via the position snapshot: already folded into base currency. */
function bookPosition(
  symbol: string,
  positionAvgPrice: number,
  opts: { orderCcy?: string | null; brokerCcy?: string | null; portfolioCurrency?: string } = {},
) {
  return resolveFillRecord({
    symbol,
    candidates: [{ source: "saxo_position_avg_price", value: positionAvgPrice, raw: false }],
    orderCcy: opts.orderCcy ?? null,
    brokerCcy: opts.brokerCcy ?? null,
    portfolioCurrency: opts.portfolioCurrency ?? "GBP",
  });
}

/** Presumed fill: the last cached close, which is a raw venue quote. */
function bookPresumed(symbol: string, cachedClose: number, portfolioCurrency = "GBP") {
  return resolveFillRecord({
    symbol,
    candidates: [{ source: "price_cache_close", value: cachedClose, raw: true }],
    portfolioCurrency,
  });
}

describe("executor fill unit parity", () => {
  it("folds GBX-quoted LSE common stocks into pounds", () => {
    expect(bookExecutor("HSBA.L", 1556.2)?.fillPrice).toBeCloseTo(15.562, 6);
    expect(bookExecutor("MKS.L", 405.278662)?.fillPrice).toBeCloseTo(4.05278662, 8);
    expect(bookExecutor("TSCO.L", 487.163485)?.fillPrice).toBeCloseTo(4.87163485, 8);
  });

  it("leaves pound-quoted LSE ETFs untouched", () => {
    expect(bookExecutor("VUKE.L", 47.255)?.fillPrice).toBeCloseTo(47.255, 6);
    expect(bookExecutor("VMID.L", 36.44)?.fillPrice).toBeCloseTo(36.44, 6);
  });

  it("leaves non-LSE listings untouched and books their own currency", () => {
    const aapl = bookExecutor("AAPL", 342.87);
    expect(aapl?.fillPrice).toBeCloseTo(342.87, 6);
    expect(aapl?.currency).toBe("USD");
  });

  it("books LSE fills in GBP, never GBX", () => {
    expect(bookExecutor("HSBA.L", 1556.2)?.currency).toBe("GBP");
    expect(bookExecutor("HSBA.L", 1556.2, { orderCcy: "GBX" })?.currency).toBe("GBP");
  });

  it("refuses to book a zero or missing broker price", () => {
    expect(bookExecutor("HSBA.L", 0)).toBeNull();
    expect(bookExecutor("HSBA.L", null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Every writer must land on the same number
// ---------------------------------------------------------------------------

describe("cross-writer parity", () => {
  // Each writer sees the instrument in its own natural form: the executor and
  // /hist get the raw venue quote (GBX for LSE commons), the position snapshot
  // gets a value already folded to base. All three must store the same price.
  const cases: { symbol: string; venueQuote: number; baseQuote: number; ccy: string }[] = [
    { symbol: "HSBA.L", venueQuote: 1556.2, baseQuote: 15.562, ccy: "GBP" },
    { symbol: "MKS.L", venueQuote: 405.28, baseQuote: 4.0528, ccy: "GBP" },
    { symbol: "VUSA.L", venueQuote: 92.14, baseQuote: 92.14, ccy: "GBP" },
    { symbol: "AAPL", venueQuote: 342.87, baseQuote: 342.87, ccy: "USD" },
  ];

  it.each(cases)("$symbol books identically from every path", (c) => {
    const executor = bookExecutor(c.symbol, c.venueQuote);
    const hist = bookHist(c.symbol, c.venueQuote);
    const position = bookPosition(c.symbol, c.baseQuote);
    const presumed = bookPresumed(c.symbol, c.venueQuote);

    for (const r of [executor, hist, position, presumed]) {
      expect(r).not.toBeNull();
      expect(r!.fillPrice).toBeCloseTo(c.baseQuote, 8);
      expect(r!.currency).toBe(c.ccy);
    }
  });

  it("falls back to the order limit price in the same units as a real fill", () => {
    // Limit prices are stored already-normalised (raw: false), so a fallback
    // fill must not be folded a second time.
    const fromHist = bookHist("HSBA.L", 1556.2);
    const fromLimit = bookHist("HSBA.L", null, 15.562);
    expect(fromLimit?.fillPrice).toBeCloseTo(fromHist!.fillPrice, 8);
    expect(fromLimit?.fallback).toBe(true);
    expect(fromHist?.fallback).toBe(false);
    expect(fromLimit?.priceSource).toBe("order_limit_price");
  });

  it("is idempotent — re-resolving a stored fill never folds it twice", () => {
    const first = bookExecutor("MKS.L", 405.28)!;
    const again = bookPosition("MKS.L", first.fillPrice);
    expect(again?.fillPrice).toBeCloseTo(first.fillPrice, 10);
    expect(again?.currency).toBe(first.currency);
  });

  it("never stores an LSE common at a plausible-looking pence value", () => {
    // The regression signature: a GBP-tagged row 100x too large.
    for (const sym of ["HSBA.L", "MKS.L", "TSCO.L", "BP.L", "SHEL.L", "LLOY.L"]) {
      const r = bookExecutor(sym, 1234.5)!;
      expect(r.fillPrice).toBeCloseTo(12.345, 8);
      expect(r.fillPrice).toBeLessThan(100);
      expect(r.currency).toBe("GBP");
    }
  });
});

// ---------------------------------------------------------------------------
// Symbol dialects: the same instrument arrives spelled differently per broker
// ---------------------------------------------------------------------------

describe("symbol dialect parity", () => {
  it("treats Yahoo (.L) and Saxo broker-native (:xlon) LSE symbols alike", () => {
    const yahoo = bookExecutor("MKS.L", 405.28)!;
    const saxo = bookExecutor("MKS:xlon", 405.28)!;
    const saxoUpper = bookExecutor("MKS:XLON", 405.28)!;
    expect(saxo.fillPrice).toBeCloseTo(yahoo.fillPrice, 10);
    expect(saxoUpper.fillPrice).toBeCloseTo(yahoo.fillPrice, 10);
    expect(saxo.currency).toBe("GBP");
    expect(saxoUpper.currency).toBe("GBP");
  });

  it("keeps the GBP-quoted allowlist intact across dialects", () => {
    expect(bookExecutor("VUSA.L", 92.14)?.fillPrice).toBeCloseTo(92.14, 8);
    expect(bookExecutor("VUSA:xlon", 92.14)?.fillPrice).toBeCloseTo(92.14, 8);
  });

  it("does not fold US broker-native symbols", () => {
    const dot = bookExecutor("AAPL", 342.87)!;
    const mic = bookExecutor("AAPL:xnas", 342.87)!;
    expect(mic.fillPrice).toBeCloseTo(dot.fillPrice, 10);
    expect(mic.currency).toBe("USD");
  });

  it("tolerates surrounding whitespace and casing from broker payloads", () => {
    expect(bookExecutor("  hsba.l  ", 1556.2)?.fillPrice).toBeCloseTo(15.562, 8);
    expect(bookExecutor("hsba.l", 1556.2)?.currency).toBe("GBP");
  });
});

// ---------------------------------------------------------------------------
// Fractional shares and price precision
// ---------------------------------------------------------------------------

describe("fractional shares and precision", () => {
  it("keeps notional consistent for fractional quantities after folding", () => {
    // What matters downstream is quantity x price. A GBX fill booked raw would
    // overstate a 0.5-share notional by 100x.
    const qty = 0.5;
    const r = bookExecutor("HSBA.L", 1556.2)!;
    expect(qty * r.fillPrice).toBeCloseTo((qty * 1556.2) / 100, 8);
    expect(qty * r.fillPrice).toBeCloseTo(7.781, 8);
  });

  it.each([0.0001, 0.001, 0.25, 1 / 3, 7.5, 12345.6789])(
    "preserves notional parity across writers at qty %s",
    (qty) => {
      const executor = bookExecutor("MKS.L", 405.278662)!;
      const position = bookPosition("MKS.L", 4.05278662)!;
      expect(qty * executor.fillPrice).toBeCloseTo(qty * position.fillPrice, 10);
    },
  );

  it("does not round sub-penny fill prices away", () => {
    const r = bookExecutor("MKS.L", 405.123456789)!;
    expect(r.fillPrice).toBeCloseTo(4.05123456789, 10);
    // Still strictly positive after folding — no truncation to zero.
    expect(r.fillPrice).toBeGreaterThan(0);
  });

  it("books very small GBX quotes without collapsing to zero", () => {
    // Penny shares: 0.42p is a real quote and must survive as 0.0042 GBP.
    const r = bookExecutor("PENNY.L", 0.42)!;
    expect(r.fillPrice).toBeCloseTo(0.0042, 10);
    expect(r.fillPrice).toBeGreaterThan(0);
  });

  it("accepts numeric strings from broker JSON identically to numbers", () => {
    expect(bookExecutor("HSBA.L", "1556.2")?.fillPrice).toBeCloseTo(15.562, 8);
    expect(bookExecutor("AAPL", "342.87")?.fillPrice).toBeCloseTo(342.87, 8);
  });

  it("rejects non-numeric, negative and non-finite broker prices", () => {
    expect(bookExecutor("HSBA.L", "n/a")).toBeNull();
    expect(bookExecutor("HSBA.L", -12.5)).toBeNull();
    expect(bookExecutor("HSBA.L", Number.NaN)).toBeNull();
    expect(bookExecutor("HSBA.L", Number.POSITIVE_INFINITY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Currency pairs across venues
// ---------------------------------------------------------------------------

describe("currency resolution across venues", () => {
  const venues: { symbol: string; expected: string }[] = [
    { symbol: "AAPL:xnas", expected: "USD" },
    { symbol: "JPM:xnys", expected: "USD" },
    { symbol: "HSBA.L", expected: "GBP" },
    { symbol: "MKS:xlon", expected: "GBP" },
    { symbol: "SAP:xetr", expected: "EUR" },
    { symbol: "ASML:xams", expected: "EUR" },
    { symbol: "NESN:xswx", expected: "CHF" },
    { symbol: "VOLV-B:xsto", expected: "SEK" },
    { symbol: "NOVO-B:xcse", expected: "DKK" },
    { symbol: "SHOP:xtse", expected: "CAD" },
  ];

  it.each(venues)("books $symbol in $expected", ({ symbol, expected }) => {
    expect(bookExecutor(symbol, 100)?.currency).toBe(expected);
  });

  it("prefers the order's instrument_ccy over the venue rule", () => {
    // A dual-listed line can settle in a currency the venue rule wouldn't guess.
    expect(bookExecutor("RDSA.L", 20, { orderCcy: "EUR" })?.currency).toBe("EUR");
    expect(bookPosition("AAPL", 342.87, { orderCcy: "USD" })?.currency).toBe("USD");
  });

  it("uses the broker-reported currency when the order carries none", () => {
    expect(bookPosition("XYZ", 10, { brokerCcy: "CHF" })?.currency).toBe("CHF");
  });

  it("rejects pence-style quote units from either the order or the broker", () => {
    // GBX/ZAC/ILA look like ISO codes but are 1/100 units. Booking them as a
    // currency is exactly how a 100x row gets in.
    expect(bookExecutor("HSBA.L", 1556.2, { orderCcy: "GBX" })?.currency).toBe("GBP");
    expect(bookPosition("HSBA.L", 15.562, { brokerCcy: "GBX" })?.currency).toBe("GBP");
    expect(resolveFillCurrency({ symbol: "HSBA.L", orderCcy: "ZAC" })).toBe("GBP");
    expect(resolveFillCurrency({ symbol: "HSBA.L", orderCcy: "ILA" })).toBe("GBP");
  });

  it("never books a fill in a non-currency quote unit", () => {
    const banned = new Set(["GBX", "ZAC", "ILA", "GBP0"]);
    for (const { symbol } of venues) {
      const r = bookExecutor(symbol, 100, { orderCcy: "GBX" })!;
      expect(banned.has(r.currency)).toBe(false);
      expect(r.currency).toMatch(/^[A-Z]{3}$/);
    }
  });

  it("falls back to the portfolio base currency for unknown listings", () => {
    expect(bookExecutor("UNKNOWNCO", 10, { portfolioCurrency: "GBP" })?.currency).toBe("GBP");
    expect(bookExecutor("UNKNOWNCO", 10, { portfolioCurrency: "EUR" })?.currency).toBe("EUR");
  });

  it("does not let a non-GBP portfolio base rescale an LSE fill", () => {
    // The unit fold is a venue property, not a portfolio property.
    const gbpBase = bookExecutor("HSBA.L", 1556.2, { portfolioCurrency: "GBP" })!;
    const usdBase = bookExecutor("HSBA.L", 1556.2, { portfolioCurrency: "USD" })!;
    expect(usdBase.fillPrice).toBeCloseTo(gbpBase.fillPrice, 10);
    expect(usdBase.currency).toBe("GBP");
  });

  it("books crypto and FX pairs in their quote leg without folding", () => {
    const btc = bookExecutor("BTC-USD", 61234.56)!;
    expect(btc.fillPrice).toBeCloseTo(61234.56, 6);
    expect(btc.currency).toBe("USD");

    const btcGbp = bookExecutor("BTC-GBP", 48250.1234)!;
    expect(btcGbp.fillPrice).toBeCloseTo(48250.1234, 6);
    expect(btcGbp.currency).toBe("GBP");
  });
});
