// Unit-resolution parity across LSE ticker spellings.
//
// The pence/GBP rule is only safe if it survives *every* spelling a symbol can
// reach us in: broker-native ("MKS:xlon"), Yahoo-style ("MKS.L"), uppercase
// MIC, mixed case, and stray whitespace. The original incident only covered
// MKS:xlon; a spelling that resolves differently silently drops the row back to
// a cost-basis fallback (100x inflation) or divides a GBP ETF by 100.
//
// The invariant every test below asserts: for one instrument, resolution,
// GBX-ness, and the normalised GBP price must be identical for all spellings —
// and the divisor must be applied exactly once.

import { describe, expect, it } from "vitest";
import { engineSymbolKey, priceSymbolVariants, resolvePriceSymbol } from "../price-symbol";
import {
  isLseGbxDisplayQuoted,
  isLsePenceQuoted,
  marketQuoteCurrency,
  normalizeLseDisplayPriceToBase,
  normalizeMarketPriceForTrading,
} from "../market-price-units";

/** Every spelling of one instrument we must handle identically. */
function spellings(root: string): string[] {
  return [
    `${root}:xlon`,
    `${root}:XLON`,
    `${root.toLowerCase()}:xlon`,
    `${root}.L`,
    `${root.toLowerCase()}.l`,
    `  ${root}:xlon  `,
  ];
}

// Pence-quoted LSE common stocks, with a realistic GBX quote and the GBP it
// must resolve to. These are the tickers the currency-mismatch banner flagged.
const GBX_CASES: Array<{ root: string; gbx: number; gbp: number }> = [
  { root: "MKS", gbx: 405.1, gbp: 4.051 },
  { root: "HSBA", gbx: 1555.19, gbp: 15.5519 },
  { root: "ULVR", gbx: 4620, gbp: 46.2 },
  { root: "TSCO", gbx: 388.4, gbp: 3.884 },
  { root: "BP", gbx: 452.3, gbp: 4.523 },
  { root: "SHEL", gbx: 2700, gbp: 27 },
  { root: "AZN", gbx: 11250, gbp: 112.5 },
  { root: "LLOY", gbx: 62.18, gbp: 0.6218 },
  { root: "BARC", gbx: 342.55, gbp: 3.4255 },
  { root: "GLEN", gbx: 289.9, gbp: 2.899 },
  { root: "RIO", gbx: 4711, gbp: 47.11 },
  { root: "VOD", gbx: 76.42, gbp: 0.7642 },
  // iShares-style LSE ETFs are GBX too — the "all ETFs are GBP" shortcut is
  // exactly what inflated a sim portfolio to ~9.2M.
  { root: "ISF", gbx: 1062.5, gbp: 10.625 },
  { root: "SGLN", gbx: 7690, gbp: 76.9 },
  { root: "IWDA", gbx: 8215, gbp: 82.15 },
];

// Allowlisted LSE tickers whose feed already arrives in pounds: dividing these
// by 100 under-reports the position by 99%.
const GBP_CASES: Array<{ root: string; gbp: number }> = [
  { root: "VUKE", gbp: 47.62 },
  { root: "VMID", gbp: 36.4425 },
  { root: "VUSA", gbp: 88.31 },
  { root: "VWRL", gbp: 112.04 },
  { root: "VHYL", gbp: 59.7 },
  { root: "VEUR", gbp: 34.15 },
  { root: "VGOV", gbp: 18.42 },
];

describe("resolution parity across LSE spellings", () => {
  for (const { root } of [...GBX_CASES, ...GBP_CASES]) {
    it(`${root}: every spelling resolves to ${root}.L`, () => {
      for (const spelling of spellings(root)) {
        expect(resolvePriceSymbol(spelling.trim()).toUpperCase()).toBe(`${root}.L`);
        expect(engineSymbolKey(spelling)).toBe(`${root}.L`);
      }
    });

    it(`${root}: every spelling is recognised as an LSE listing`, () => {
      for (const spelling of spellings(root)) {
        expect(isLsePenceQuoted(spelling)).toBe(true);
      }
    });
  }
});

describe("GBX parity — one divisor, every spelling", () => {
  for (const { root, gbx, gbp } of GBX_CASES) {
    it(`${root}: ${gbx}p → £${gbp} for all spellings`, () => {
      for (const spelling of spellings(root)) {
        expect(isLseGbxDisplayQuoted(spelling)).toBe(true);
        expect(marketQuoteCurrency(spelling)).toBe("GBX");
        expect(normalizeLseDisplayPriceToBase(spelling, gbx)).toBeCloseTo(gbp, 6);
        // Trading and display must never disagree about scale.
        expect(normalizeMarketPriceForTrading(spelling, gbx)).toBeCloseTo(gbp, 6);
      }
    });

    it(`${root}: normalising the canonical key matches the broker spelling`, () => {
      const canonical = resolvePriceSymbol(`${root}:xlon`);
      expect(normalizeLseDisplayPriceToBase(canonical, gbx)).toBeCloseTo(
        normalizeLseDisplayPriceToBase(`${root}:xlon`, gbx),
        9,
      );
    });
  }
});

describe("GBP-allowlisted LSE tickers stay unscaled in every spelling", () => {
  for (const { root, gbp } of GBP_CASES) {
    it(`${root}: £${gbp} passes through untouched`, () => {
      for (const spelling of spellings(root)) {
        expect(isLsePenceQuoted(spelling)).toBe(true); // it *is* an LSE listing
        expect(isLseGbxDisplayQuoted(spelling)).toBe(false); // but quoted in GBP
        expect(marketQuoteCurrency(spelling)).toBe(null);
        expect(normalizeLseDisplayPriceToBase(spelling, gbp)).toBe(gbp);
        expect(normalizeMarketPriceForTrading(spelling, gbp)).toBe(gbp);
      }
    });
  }
});

describe("quote-key variants cover every lookup spelling", () => {
  for (const { root, gbx, gbp } of GBX_CASES.slice(0, 6)) {
    it(`${root}: a quote published under its variants is found by any probe`, () => {
      const broker = `${root}:xlon`;
      const canonical = resolvePriceSymbol(broker);
      const map = new Map<string, number>();
      for (const key of new Set([broker, canonical, ...priceSymbolVariants(broker)])) {
        // Publish under the canonical GBP value — the engine normalises once,
        // at fetch time, then stores base-currency prices.
        map.set(key.toUpperCase(), gbp);
        map.set(key.toLowerCase(), gbp);
      }
      for (const probe of spellings(root)) {
        const hit = map.get(probe.trim().toUpperCase()) ?? map.get(probe.trim().toLowerCase());
        expect(hit).toBeCloseTo(gbp, 9);
        // And the published value is the once-normalised one, not the raw GBX.
        expect(hit).not.toBeCloseTo(gbx, 3);
      }
    });
  }

  it("variants always include both the broker and canonical spelling", () => {
    for (const { root } of GBX_CASES) {
      const variants = priceSymbolVariants(`${root}:xlon`);
      expect(variants).toContain(`${root}:XLON`);
      expect(variants).toContain(`${root}.L`);
    }
  });
});

describe("non-LSE spellings are never pence-scaled", () => {
  const foreign: Array<[string, number]> = [
    ["AAPL:xnas", 189.42],
    ["AAPL", 189.42],
    ["MSFT:xnas", 412.6],
    ["SAP:xetr", 145.6],
    ["SAP.DE", 145.6],
    ["ASML:xams", 812.4],
    ["MC:xpar", 640.1],
    ["7203:xtks", 2650],
    ["7203.T", 2650],
    ["ZETH:xswx", 41.2],
    ["BHP:xasx", 44.9],
  ];
  for (const [symbol, price] of foreign) {
    it(`${symbol} passes through unchanged`, () => {
      expect(isLsePenceQuoted(symbol)).toBe(false);
      expect(isLseGbxDisplayQuoted(symbol)).toBe(false);
      expect(normalizeLseDisplayPriceToBase(symbol, price)).toBe(price);
      expect(normalizeMarketPriceForTrading(symbol, price)).toBe(price);
    });
  }

  it("a US ticker whose root ends in L is not mistaken for an LSE listing", () => {
    for (const s of ["DAL", "AAL", "GOOGL", "GOOGL:xnas", "INTL"]) {
      expect(isLsePenceQuoted(s)).toBe(false);
      expect(normalizeLseDisplayPriceToBase(s, 1200)).toBe(1200);
    }
  });
});

describe("double-normalisation signatures stay absent", () => {
  it("a single normalisation never yields sub-penny prices for GBX stocks", () => {
    for (const { root, gbx, gbp } of GBX_CASES) {
      const once = normalizeLseDisplayPriceToBase(`${root}:xlon`, gbx);
      expect(once).toBeCloseTo(gbp, 6);
      // Second pass is the bug we guard against: assert the shape so a caller
      // adding another division is caught by the 100x gap.
      const twice = normalizeLseDisplayPriceToBase(`${root}.L`, once);
      expect(twice).toBeCloseTo(gbp / 100, 9);
      expect(once / twice).toBeCloseTo(100, 6);
    }
  });
});
