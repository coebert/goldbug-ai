// Regression: expand coverage of the LSE GBX vs GBP quote-scale bug beyond
// the original HSBA / VUKE / VMID incident. Any new ticker suffix, casing
// quirk, or ETF variant that slips past `normalizeLseDisplayPriceToBase`
// re-opens the unit-mixing bug that made ETFs render as 0.0% of the tile.

import { describe, it, expect } from "vitest";
import {
  isLsePenceQuoted,
  isLseGbxDisplayQuoted,
  marketQuoteCurrency,
  normalizeLseDisplayPriceToBase,
  normalizeMarketPriceForTrading,
} from "@/lib/market-price-units";
import { allocateRoundedShares } from "@/lib/format-money";

describe("isLsePenceQuoted — suffix and casing variants", () => {
  const lseYes = [
    "HSBA.L", "hsba.l", "BP.L", "SHEL.L", "AZN.L", "GSK.L", "ULVR.L",
    "RIO.L", "GLEN.L", "LLOY.L", "BARC.L", "TSCO.L", "VOD.L", "REL.L",
    "HSBA:xlon", "hsba:XLON", "BP:xlon", "SHEL:XLON", "AZN:xlon",
  ];
  for (const s of lseYes) {
    it(`treats ${s} as LSE (pence-quoted)`, () => {
      expect(isLsePenceQuoted(s)).toBe(true);
      expect(marketQuoteCurrency(s)).toBe("GBX");
    });
  }

  const lseNo = [
    "AAPL", "MSFT", "TSLA", "SAP.DE", "ASML.AS", "AIR.PA", "MC.PA",
    "7203.T", "005930.KS", "BABA", "NVDA", "SPY", "QQQ",
    // .L-lookalike but not LSE: keep guard tight so we don't false-positive.
    "GOOGL", "META", "BRK.B",
  ];
  for (const s of lseNo) {
    it(`does not treat ${s} as LSE`, () => {
      expect(isLsePenceQuoted(s)).toBe(false);
      expect(marketQuoteCurrency(s)).toBe(null);
    });
  }
});

describe("isLseGbxDisplayQuoted — asset-class routing", () => {
  it("common stocks are GBX-quoted for display", () => {
    for (const s of ["HSBA.L", "BP.L", "SHEL.L", "AZN:xlon", "LLOY.L"]) {
      expect(isLseGbxDisplayQuoted(s, "stock")).toBe(true);
      expect(isLseGbxDisplayQuoted(s, "equity")).toBe(true); // unknown-non-ETF
    }
  });

  it("only the allowlisted Vanguard LSE tickers are GBP-quoted", () => {
    for (const s of ["VUKE.L", "VMID.L", "VWRL.L", "VUSA.L", "VHYL.L",
                     "VEUR.L", "VJPN.L", "VUKE:xlon", "VMID:xlon"]) {
      expect(isLseGbxDisplayQuoted(s, "etf")).toBe(false);
      expect(isLseGbxDisplayQuoted(s, "ETF")).toBe(false);
    }
  });

  it("iShares-style LSE ETFs stay GBX (regression: 100x inflated equity)", () => {
    // ISF.L quotes ~1062p and SGLN.L ~7690p. Treating them as pounds made a
    // simulated portfolio read ~9.2M instead of ~92k.
    for (const s of ["ISF.L", "SGLN.L", "IUKD.L", "IGLN.L", "CSPX.L",
                     "EMIM.L", "IWDA.L", "ISF:xlon", "sgln:xlon"]) {
      expect(isLseGbxDisplayQuoted(s, "etf")).toBe(true);
    }
  });

  it("missing asset_class falls back to GBX (conservative for common stocks)", () => {
    // Nulls occur for freshly-inserted holdings before classification runs.
    expect(isLseGbxDisplayQuoted("HSBA.L", null)).toBe(true);
    expect(isLseGbxDisplayQuoted("HSBA.L", undefined)).toBe(true);
    expect(isLseGbxDisplayQuoted("HSBA.L", "")).toBe(true);
  });

  it("non-LSE symbols are never treated as GBX regardless of asset_class", () => {
    for (const s of ["AAPL", "SAP.DE", "7203.T", "SPY", "005930.KS"]) {
      expect(isLseGbxDisplayQuoted(s, "stock")).toBe(false);
      expect(isLseGbxDisplayQuoted(s, "etf")).toBe(false);
      expect(isLseGbxDisplayQuoted(s, null)).toBe(false);
    }
  });
});

describe("normalizeLseDisplayPriceToBase — numeric conversion", () => {
  it("divides LSE common-stock GBX by 100 to yield GBP", () => {
    expect(normalizeLseDisplayPriceToBase("HSBA.L", 1555.19, "stock")).toBeCloseTo(15.5519, 6);
    expect(normalizeLseDisplayPriceToBase("BP.L", 452.30, "stock")).toBeCloseTo(4.5230, 6);
    expect(normalizeLseDisplayPriceToBase("SHEL:xlon", 2700, "stock")).toBeCloseTo(27, 6);
  });

  it("leaves GBP-quoted LSE ETFs unchanged but folds GBX ETFs", () => {
    expect(normalizeLseDisplayPriceToBase("VUKE.L", 46.34, "etf")).toBe(46.34);
    expect(normalizeLseDisplayPriceToBase("VMID:xlon", 36.4425, "etf")).toBe(36.4425);
    expect(normalizeLseDisplayPriceToBase("ISF.L", 812.5, "etf")).toBeCloseTo(8.125, 6);
    expect(normalizeLseDisplayPriceToBase("SGLN:xlon", 7690, "etf")).toBeCloseTo(76.9, 6);
  });

  it("leaves non-LSE symbols unchanged regardless of numeric magnitude", () => {
    // USD, EUR, JPY, KRW all pass through untouched — no currency guessing.
    expect(normalizeLseDisplayPriceToBase("AAPL", 189.42, "stock")).toBe(189.42);
    expect(normalizeLseDisplayPriceToBase("SAP.DE", 145.6, "stock")).toBe(145.6);
    expect(normalizeLseDisplayPriceToBase("7203.T", 2650, "stock")).toBe(2650); // JPY
    expect(normalizeLseDisplayPriceToBase("005930.KS", 71000, "stock")).toBe(71000); // KRW
  });

  it("handles non-finite prices without exploding", () => {
    expect(normalizeLseDisplayPriceToBase("HSBA.L", NaN, "stock")).toBe(0);
    expect(normalizeLseDisplayPriceToBase("HSBA.L", Infinity, "stock")).toBe(0);
    expect(normalizeLseDisplayPriceToBase("VUKE.L", NaN, "etf")).toBe(0);
  });

  it("is idempotent when re-run on an already-normalised GBP figure only if the input is already GBP-scale", () => {
    // The helper does not detect double-normalisation — it always divides
    // GBX-eligible symbols by 100. This lock-in ensures callers know they
    // must not call it twice on the same value.
    const once = normalizeLseDisplayPriceToBase("HSBA.L", 1555.19, "stock");
    const twice = normalizeLseDisplayPriceToBase("HSBA.L", once, "stock");
    expect(once).toBeCloseTo(15.5519, 6);
    expect(twice).toBeCloseTo(0.155519, 6); // catches accidental double-call
  });
});

describe("normalizeMarketPriceForTrading — order sizing path", () => {
  it("divides GBX LSE quotes by 100 and leaves GBP-quoted LSE tickers alone", () => {
    // For the *trading* path, both LSE stocks and LSE ETFs are quoted in
    // pence by Yahoo — order-sizing must not depend on asset_class.
    expect(normalizeMarketPriceForTrading("HSBA.L", 1555.19)).toBeCloseTo(15.5519, 6);
    expect(normalizeMarketPriceForTrading("VUKE.L", 46.34)).toBeCloseTo(46.34, 6);
    expect(normalizeMarketPriceForTrading("VMID:xlon", 36.4425)).toBeCloseTo(36.4425, 6);
    expect(normalizeMarketPriceForTrading("ISF.L", 1062.33)).toBeCloseTo(10.6233, 6);
  });

  it("leaves non-LSE quotes unchanged", () => {
    expect(normalizeMarketPriceForTrading("AAPL", 189.42)).toBe(189.42);
    expect(normalizeMarketPriceForTrading("SAP.DE", 145.6)).toBe(145.6);
  });

  it("returns 0 for non-finite prices to fail safely in order sizing", () => {
    expect(normalizeMarketPriceForTrading("HSBA.L", NaN)).toBe(0);
    expect(normalizeMarketPriceForTrading("AAPL", Infinity)).toBe(0);
  });
});

describe("multi-currency mixing safety in largest-remainder allocation", () => {
  // Any time a portfolio mixes venues (USD stocks + LSE ETFs + LSE stocks
  // + EUR stocks + JPY stocks), display totals must first be converted to
  // a common base. The normalisation helper is only step one; the caller
  // must still apply FX. These tests lock the *contract* that raw
  // qty*price without normalisation will produce nonsensical weights, so
  // any future refactor that "simplifies away" the helper regresses.
  it("mixing GBX common stocks with GBP ETFs without normalisation crushes ETFs to zero", () => {
    const rows = [
      { symbol: "BP.L", qty: 500, avg: 452.30, ac: "stock" }, // GBX
      { symbol: "VUKE.L", qty: 50, avg: 46.34, ac: "etf" },   // GBP
      { symbol: "ISF.L", qty: 40, avg: 812.5, ac: "etf" },    // GBX
    ];
    const invested = 226150 / 100 + 2317 + 325; // ≈ £4,904 in GBP
    const raw = rows.map((r) => r.qty * r.avg);
    const rawAlloc = allocateRoundedShares(raw, invested);
    // BP.L raw = 226,150 (pence!), ETFs = 2,317 & 32,500 → BP dominates.
    expect(rawAlloc[0]).toBeGreaterThan(invested * 0.7);
    expect(rawAlloc[1]).toBeLessThan(invested * 0.1);

    const fixed = rows.map(
      (r) => r.qty * normalizeLseDisplayPriceToBase(r.symbol, r.avg, r.ac),
    );
    const fixedAlloc = allocateRoundedShares(fixed, invested);
    // BP.L GBP = 2,261.5; VUKE = 2,317; ISF = 325 → the two ~£2.3k rows now
    // show as materially non-zero.
    expect(fixedAlloc[0]).toBeGreaterThan(1500);
    expect(fixedAlloc[1]).toBeGreaterThan(1500);
    expect(fixedAlloc.reduce((a, b) => a + b, 0)).toBeCloseTo(invested, 2);
  });

  it("USD + EUR + JPY holdings pass through untouched (base-CCY conversion is caller's job)", () => {
    // The normaliser must NOT invent an FX conversion for foreign quotes.
    // It only handles the GBX→GBP unit fix; anything else is out of scope.
    const rows = [
      { symbol: "AAPL", qty: 10, avg: 189.42, ac: "stock" },     // USD
      { symbol: "SAP.DE", qty: 20, avg: 145.6, ac: "stock" },    // EUR
      { symbol: "7203.T", qty: 100, avg: 2650, ac: "stock" },    // JPY
    ];
    for (const r of rows) {
      expect(normalizeLseDisplayPriceToBase(r.symbol, r.avg, r.ac)).toBe(r.avg);
    }
  });
});
