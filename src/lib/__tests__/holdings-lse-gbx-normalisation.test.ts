// Contract: mixed LSE holdings (GBX-quoted stocks like HSBA.L + GBP-quoted
// ETFs like VUKE.L / VMID.L) must be normalised to a single base currency
// before per-position allocation, otherwise the pence-scaled stock swamps
// the pound-scaled ETFs and the ETFs render as 0.0% of the portfolio.
//
// Regression: 2026-07-28 real-money live_prod tile showed VMID and VUKE at
// GBP 2 / 0.0% while HSBA showed GBP 1.9k / 18.1%.

import { describe, it, expect } from "vitest";
import {
  isLseGbxDisplayQuoted,
  isLsePenceQuoted,
  normalizeLseDisplayPriceToBase,
} from "@/lib/market-price-units";
import { allocateRoundedShares } from "@/lib/format-money";

describe("LSE display normalisation", () => {
  it("treats LSE common stocks as GBX-quoted", () => {
    expect(isLsePenceQuoted("HSBA.L")).toBe(true);
    expect(isLsePenceQuoted("HSBA:xlon")).toBe(true);
    expect(isLseGbxDisplayQuoted("HSBA.L", "stock")).toBe(true);
    expect(isLseGbxDisplayQuoted("HSBA:xlon", "stock")).toBe(true);
  });

  it("treats allowlisted Vanguard LSE ETFs (VUKE / VMID) as GBP-quoted", () => {
    expect(isLseGbxDisplayQuoted("VUKE.L", "etf")).toBe(false);
    expect(isLseGbxDisplayQuoted("VMID:xlon", "etf")).toBe(false);
  });

  it("treats other LSE ETFs (ISF / SGLN) as GBX-quoted", () => {
    expect(isLseGbxDisplayQuoted("ISF.L", "etf")).toBe(true);
    expect(isLseGbxDisplayQuoted("SGLN:xlon", "etf")).toBe(true);
  });

  it("leaves non-LSE symbols untouched", () => {
    expect(isLsePenceQuoted("AAPL")).toBe(false);
    expect(isLseGbxDisplayQuoted("SAP.DE", null)).toBe(false);
  });

  it("normalises HSBA GBX to GBP but leaves VUKE/VMID alone", () => {
    expect(normalizeLseDisplayPriceToBase("HSBA:xlon", 1555.19, "stock"))
      .toBeCloseTo(15.5519, 4);
    expect(normalizeLseDisplayPriceToBase("VMID:xlon", 36.4425, "etf"))
      .toBeCloseTo(36.4425, 4);
    expect(normalizeLseDisplayPriceToBase("VUKE:xlon", 46.34, "etf"))
      .toBeCloseTo(46.34, 4);
  });

  it("prevents the ETF-goes-to-zero allocation bug on the real-money portfolio", () => {
    // Reproduce the exact holdings from the 2026-07-28 incident.
    const rows = [
      { symbol: "HSBA:xlon", qty: 102, avg: 1555.19, ac: "stock" },
      { symbol: "VMID:xlon", qty: 4,   avg: 36.4425, ac: "etf" },
      { symbol: "VUKE:xlon", qty: 3,   avg: 46.34,   ac: "etf" },
    ];
    const invested = 1865; // GBP, from equity snapshot.

    // BEFORE the fix: raw qty*avg mixes GBX (HSBA=158,629) with GBP (145, 139).
    // Largest-remainder against £1865 gives HSBA ~99% and the ETFs pennies.
    const rawWeights = rows.map((r) => r.qty * r.avg);
    const rawAlloc = allocateRoundedShares(rawWeights, invested);
    expect(rawAlloc[1]).toBeLessThan(3); // VMID pushed to ~£1.72 (the bug)
    expect(rawAlloc[2]).toBeLessThan(3); // VUKE pushed to ~£1.64 (the bug)

    // AFTER the fix: normalise per row, then allocate.
    const fixedWeights = rows.map(
      (r) => r.qty * normalizeLseDisplayPriceToBase(r.symbol, r.avg, r.ac),
    );
    const fixedAlloc = allocateRoundedShares(fixedWeights, invested);
    // ETFs must now hold a materially non-zero share of the tile.
    expect(fixedAlloc[1]).toBeGreaterThan(100); // VMID ≈ £145 pre-round
    expect(fixedAlloc[2]).toBeGreaterThan(100); // VUKE ≈ £139 pre-round
    // Allocation still sums to the authoritative invested figure exactly.
    expect(fixedAlloc.reduce((a, b) => a + b, 0)).toBeCloseTo(invested, 2);
  });
});
