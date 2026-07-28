// Regression: LSE common stocks whose avg_cost is stored in GBX (pence)
// must not swamp GBP-quoted ETF rows in the HoldingsStrip. On
// 2026-07-28 a real portfolio held HSBA:xlon (102 @ 1555.19p),
// VMID:xlon (4 @ £36.44 GBP) and VUKE:xlon (3 @ £46.34 GBP). The
// broker snapshot said totalEquity=£10,280, cash=£8,419 →
// invested=£1,861. Because avg_cost for HSBA was pence, the raw
// cost-basis for HSBA was 102×1555.19 = £158,629 which dwarfed the
// ETF rows and scaled their chip weights to ~0.09%, rendering as
// "0.0%" while HSBA showed "18.1%". After normalising GBX → GBP for
// LSE common stocks (asset_class !== 'etf'), all three chips should
// share the £1,861 invested pot proportionally and no ETF row should
// round to 0.0% weight.

import { describe, expect, it } from "vitest";
import { deriveStripAllocation } from "@/lib/derive-strip-allocation";

describe("deriveStripAllocation — LSE GBX avg_cost must not zero out ETF rows", () => {
  it("HSBA:xlon (GBX pence) alongside VMID/VUKE:xlon (GBP) — all chips get proportional weight", () => {
    const a = deriveStripAllocation(
      [
        { symbol: "HSBA:xlon", quantity: 102, avg_cost: 1555.19, asset_class: "stock" },
        { symbol: "VMID:xlon", quantity: 4, avg_cost: 36.44, asset_class: "etf" },
        { symbol: "VUKE:xlon", quantity: 3, avg_cost: 46.34, asset_class: "etf" },
      ],
      8419.49,
      10280.67,
    );
    // Normalised cost basis: HSBA 102×15.5519 ≈ £1586.29, VMID ≈ £145.76, VUKE ≈ £139.02.
    // rawInvested ≈ £1871.07 → scale ≈ 1861.18/1871.07 ≈ 0.9947.
    const byName = Object.fromEntries(a.chips.map((c) => [c.symbol, c]));
    expect(byName["HSBA:xlon"].value).toBeGreaterThan(1500);
    expect(byName["HSBA:xlon"].value).toBeLessThan(1650);
    expect(byName["VMID:xlon"].value).toBeGreaterThan(100);
    expect(byName["VUKE:xlon"].value).toBeGreaterThan(100);
    // The critical assertion: ETF chip weights, when rounded to one
    // decimal (the display format), must NOT be 0.0%.
    expect(Number(byName["VMID:xlon"].weight.toFixed(1))).toBeGreaterThan(0);
    expect(Number(byName["VUKE:xlon"].weight.toFixed(1))).toBeGreaterThan(0);
    // And invariants still hold.
    expect(a.investedPct + a.cashPct).toBeCloseTo(100, 6);
  });

  it("LSE ETFs (asset_class='etf') pass through unchanged — avg_cost already GBP", () => {
    const a = deriveStripAllocation(
      [{ symbol: "VUKE:xlon", quantity: 10, avg_cost: 46, asset_class: "etf" }],
      540,
      1000,
    );
    // rawInvested must be £460, not £4.60.
    expect(a.rawInvested).toBe(460);
    expect(a.investedValue).toBe(460);
  });

  it(".L suffix common stock (asset_class='stock') is normalised too", () => {
    const a = deriveStripAllocation(
      [{ symbol: "LLOY.L", quantity: 100, avg_cost: 55.4, asset_class: "stock" }],
      100,
      155.4,
    );
    // 100 × 0.554 = £55.40, not £5540.
    expect(a.rawInvested).toBeCloseTo(55.4, 6);
  });
});
