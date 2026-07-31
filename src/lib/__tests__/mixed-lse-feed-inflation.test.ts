// Regression guard for the 100x LSE unit-mixing bug, specifically for
// **mixed feeds**: a single portfolio holding pence-quoted LSE stocks and
// iShares ETFs (ISF, SGLN — pence) alongside the Vanguard UK range
// (VUKE, VMID — already pounds).
//
// The original incident had two distinct failure modes and both must stay
// closed:
//   1. Treating "all LSE ETFs" as GBP-quoted → iShares legs inflated 100x
//      (a sim portfolio read ~9.2M instead of ~92k).
//   2. Over-correcting and dividing the Vanguard legs by 100 → those rows
//      collapse to ~0.0% of the tile.
//
// These tests pin realistic July-2026 quotes so an accidental widening of the
// GBP allowlist (or a return to asset_class-based routing) fails loudly with
// a ~100x total, not a subtle drift.

import { describe, it, expect } from "vitest";
import {
  isLseGbxDisplayQuoted,
  marketQuoteCurrency,
  normalizeLseDisplayPriceToBase,
  normalizeMarketPriceForTrading,
} from "@/lib/market-price-units";
import { valueBrokerPositions } from "@/lib/broker-positions-value";
import { positionsOn, valuePositionsOn } from "@/lib/equity-snapshot-revalue";

/** Raw feed quotes as our providers deliver them (Yahoo / Saxo). */
const FEED = {
  // Pence-quoted: LSE common stocks.
  "HSBA.L": 1123.5,
  "ULVR.L": 4743,
  "TSCO.L": 490.7,
  "MKS.L": 403.1,
  // Pence-quoted: iShares ETFs. NOT GBP despite being ETFs.
  "ISF.L": 1059,
  "SGLN.L": 5819,
  "IUKD.L": 341.2,
  // GBP-quoted: the verified Vanguard UK allowlist.
  "VUKE.L": 47.62,
  "VMID.L": 36.58,
  "VWRL.L": 116.4,
} as const;

/** What each raw quote must become once folded to GBP. */
const EXPECTED_GBP: Record<keyof typeof FEED, number> = {
  "HSBA.L": 11.235,
  "ULVR.L": 47.43,
  "TSCO.L": 4.907,
  "MKS.L": 4.031,
  "ISF.L": 10.59,
  "SGLN.L": 58.19,
  "IUKD.L": 3.412,
  "VUKE.L": 47.62,
  "VMID.L": 36.58,
  "VWRL.L": 116.4,
};

describe("mixed LSE feed — per-symbol unit classification", () => {
  for (const [symbol, raw] of Object.entries(FEED)) {
    const expected = EXPECTED_GBP[symbol as keyof typeof FEED];
    const pence = expected !== raw;

    it(`${symbol} folds ${raw} → ${expected} GBP`, () => {
      expect(isLseGbxDisplayQuoted(symbol)).toBe(pence);
      expect(marketQuoteCurrency(symbol)).toBe(pence ? "GBX" : null);
      expect(normalizeLseDisplayPriceToBase(symbol, raw)).toBeCloseTo(expected, 6);
      // Order sizing must agree with display or the ledger drifts from tiles.
      expect(normalizeMarketPriceForTrading(symbol, raw)).toBeCloseTo(expected, 6);
    });

    it(`${symbol} keeps its unit rule under :xlon spelling and casing`, () => {
      const root = symbol.slice(0, -2);
      for (const variant of [`${root}:xlon`, `${root}:XLON`, symbol.toLowerCase()]) {
        expect(isLseGbxDisplayQuoted(variant)).toBe(pence);
        expect(normalizeLseDisplayPriceToBase(variant, raw)).toBeCloseTo(expected, 6);
      }
    });

    it(`${symbol} ignores asset_class when deciding the unit`, () => {
      for (const cls of ["etf", "ETF", "stock", "fund", null, undefined]) {
        expect(normalizeLseDisplayPriceToBase(symbol, raw, cls)).toBeCloseTo(expected, 6);
      }
    });
  }
});

describe("mixed LSE feed — broker position valuation", () => {
  // A realistic mixed book: iShares pence legs + Vanguard pound legs.
  const positions = [
    { symbol: "ISF:xlon", quantity: 2266, marketPrice: FEED["ISF.L"], assetClass: "etf" },
    { symbol: "SGLN:xlon", quantity: 892, marketPrice: FEED["SGLN.L"], assetClass: "etf" },
    { symbol: "ULVR:xlon", quantity: 91, marketPrice: FEED["ULVR.L"], assetClass: "stock" },
    { symbol: "VUKE:xlon", quantity: 500, marketPrice: FEED["VUKE.L"], assetClass: "etf" },
    { symbol: "VMID:xlon", quantity: 300, marketPrice: FEED["VMID.L"], assetClass: "etf" },
  ];

  const penceLegs = 2266 * 10.59 + 892 * 58.19 + 91 * 47.43;
  const poundLegs = 500 * 47.62 + 300 * 36.58;

  it("values pence and pound legs on one scale", () => {
    expect(valueBrokerPositions(positions)).toBeCloseTo(penceLegs + poundLegs, 2);
  });

  it("keeps the mixed total inside a plausible band (no 100x, no 1/100x)", () => {
    const total = valueBrokerPositions(positions);
    // ~£113k. A regression in either direction lands orders of magnitude away.
    expect(total).toBeGreaterThan(50_000);
    expect(total).toBeLessThan(500_000);
  });

  it("gives no single leg an implausible share of the book", () => {
    const total = valueBrokerPositions(positions);
    for (const p of positions) {
      const leg = valueBrokerPositions([p]);
      const share = leg / total;
      // The 100x bug drove SGLN to >98% of the tile; the over-correction
      // drove the Vanguard legs to ~0.0%.
      expect(share).toBeGreaterThan(0.005);
      expect(share).toBeLessThan(0.9);
    }
  });

  it("does not shift when the ETF legs are relabelled as stocks", () => {
    const relabelled = positions.map((p) => ({ ...p, assetClass: "stock" }));
    expect(valueBrokerPositions(relabelled)).toBeCloseTo(
      valueBrokerPositions(positions),
      2,
    );
  });

  it("falls back to avgPrice with the same unit rule", () => {
    const total = valueBrokerPositions([
      { symbol: "ISF:xlon", quantity: 100, marketPrice: null, avgPrice: 1052.4 },
      { symbol: "VUKE:xlon", quantity: 100, marketPrice: null, avgPrice: 47.1 },
    ]);
    expect(total).toBeCloseTo(100 * 10.524 + 100 * 47.1, 2);
  });
});

describe("mixed LSE feed — historical snapshot revaluation", () => {
  const holdings = [
    { symbol: "ISF:xlon", quantity: 2266, avg_cost: 1052.4, asset_class: "etf", opened_at: "2026-07-28T13:00:00Z", instrument_ccy: "GBP" },
    { symbol: "SGLN:xlon", quantity: 892, avg_cost: 5872.3, asset_class: "etf", opened_at: "2026-07-27T15:00:00Z", instrument_ccy: "GBP" },
    { symbol: "VUKE:xlon", quantity: 500, avg_cost: 46.9, asset_class: "etf", opened_at: "2026-07-27T15:00:00Z", instrument_ccy: "GBP" },
    { symbol: "HSBA:xlon", quantity: 400, avg_cost: 1100, asset_class: "stock", opened_at: "2026-07-27T15:00:00Z", instrument_ccy: "GBP" },
  ];

  const prices = new Map<string, Map<string, number>>([
    ["ISF.L", new Map([["2026-07-30", FEED["ISF.L"]]])],
    ["SGLN.L", new Map([["2026-07-30", FEED["SGLN.L"]]])],
    ["VUKE.L", new Map([["2026-07-30", FEED["VUKE.L"]]])],
    ["HSBA.L", new Map([["2026-07-30", FEED["HSBA.L"]]])],
  ]);

  const expected =
    2266 * 10.59 + 892 * 58.19 + 500 * 47.62 + 400 * 11.235;

  it("marks a mixed book to normalised GBP closes", () => {
    const book = positionsOn(holdings, [], "2026-07-30");
    expect(valuePositionsOn(book, prices, "2026-07-30")).toBeCloseTo(expected, 2);
  });

  it("applies FX after the pence fold, never instead of it", () => {
    const book = positionsOn(holdings, [], "2026-07-30");
    const eur = valuePositionsOn(book, prices, "2026-07-30", new Map([["GBP", 1.1686]]));
    expect(eur).toBeCloseTo(expected * 1.1686, 1);
    // Sanity: the GBX legs did not survive into the EUR total un-folded.
    expect(eur).toBeLessThan(expected * 2);
  });

  it("falls back to avg_cost with the same unit rule per symbol", () => {
    const book = positionsOn(holdings, [], "2026-07-26T23:59:59Z".slice(0, 10));
    // Nothing opened yet on 2026-07-26.
    expect(book.size).toBe(0);

    const laterBook = positionsOn(holdings, [], "2026-07-30");
    const noPrices = new Map<string, Map<string, number>>();
    const viaCost = valuePositionsOn(laterBook, noPrices, "2026-07-30");
    expect(viaCost).toBeCloseTo(
      2266 * 10.524 + 892 * 58.723 + 500 * 46.9 + 400 * 11,
      1,
    );
  });

  it("stays within 1% when the same book is priced twice through both paths", () => {
    const book = positionsOn(holdings, [], "2026-07-30");
    const viaRevalue = valuePositionsOn(book, prices, "2026-07-30");
    const viaBroker = valueBrokerPositions(
      holdings.map((h) => ({
        symbol: h.symbol,
        quantity: h.quantity,
        marketPrice: FEED[`${h.symbol.split(":")[0]}.L` as keyof typeof FEED],
        assetClass: h.asset_class,
      })),
    );
    expect(Math.abs(viaRevalue - viaBroker) / viaBroker).toBeLessThan(0.01);
  });
});
