// Regression: the portfolio card's HoldingsStrip allocation must be
// anchored to the broker's authoritative totalEquity. Bugs guarded:
//
//   - Invested% + Cash% > 100% (screenshot showed 94.4% + 41.3% =
//     135.7%) because Invested was Σ(qty × avg_cost) while Cash and
//     totalEquity came from the broker snapshot.
//   - "Total" line showed cost_basis + cash instead of totalEquity.
//   - Chip weights summed to a raw cost-basis %, not to investedPct.
//
// Contract locked below: Invested = totalEquity − cash; chip values
// sum to Invested; chip weights sum to Invested%; Total == totalEquity.

import { describe, expect, it } from "vitest";
import { deriveStripAllocation } from "@/lib/derive-strip-allocation";

describe("deriveStripAllocation — allocation is anchored to totalEquity", () => {
  it("cost-basis > equity (screenshot repro): pct sum to 100, invested = eq − cash", () => {
    // £301.83 equity, £124.60 cash. Cost-basis of two holdings £285.
    // Under the old bug: 94.4% invested + 41.3% cash = 135.7%.
    const a = deriveStripAllocation(
      [
        { symbol: "VMID:xlon", quantity: 1, avg_cost: 146 },
        { symbol: "VUKE:xlon", quantity: 1, avg_cost: 139 },
      ],
      124.6,
      301.83,
    );
    expect(a.investedValue).toBeCloseTo(177.23, 2);
    expect(a.safeCash).toBeCloseTo(124.6, 2);
    expect(a.denom).toBeCloseTo(301.83, 2);
    expect(a.investedPct + a.cashPct).toBeCloseTo(100, 6);
    // Chip values sum to authoritative invested (not to £285 cost basis).
    const chipSum = a.chips.reduce((s, c) => s + c.value, 0);
    expect(chipSum).toBeCloseTo(a.investedValue, 6);
    // Chip weights sum to investedPct (~58.7%), not to ~94%.
    const weightSum = a.chips.reduce((s, c) => s + c.weight, 0);
    expect(weightSum).toBeCloseTo(a.investedPct, 6);
    expect(weightSum).toBeLessThan(100);
  });

  it("cost-basis < equity (unrealised gain): invested still = eq − cash, pct sum to 100", () => {
    // £1000 equity, £200 cash → invested must be £800 (80%/20%),
    // even though holdings cost only £600.
    const a = deriveStripAllocation(
      [
        { symbol: "AAA", quantity: 10, avg_cost: 40 }, // £400 cost
        { symbol: "BBB", quantity: 10, avg_cost: 20 }, // £200 cost
      ],
      200,
      1_000,
    );
    expect(a.investedValue).toBe(800);
    expect(a.investedPct).toBeCloseTo(80, 6);
    expect(a.cashPct).toBeCloseTo(20, 6);
    expect(a.investedPct + a.cashPct).toBeCloseTo(100, 6);
    expect(a.denom).toBe(1_000);
    // Chip values scaled UP to sum to invested £800, not £600.
    const chipSum = a.chips.reduce((s, c) => s + c.value, 0);
    expect(chipSum).toBeCloseTo(800, 6);
  });

  it("100% cash, no holdings: invested 0%, cash 100%, total == cash", () => {
    const a = deriveStripAllocation([], 500, 500);
    expect(a.investedValue).toBe(0);
    expect(a.investedPct).toBe(0);
    expect(a.cashPct).toBe(100);
    expect(a.denom).toBe(500);
  });

  it("cash > totalEquity (stale snapshot): cash clamped to denom, pct sum to 100", () => {
    // Broker snapshot lags cash sync; cash > equity. Must still
    // produce a coherent 100% split.
    const a = deriveStripAllocation([], 800, 500);
    expect(a.safeCash).toBe(500);
    expect(a.investedValue).toBe(0);
    expect(a.investedPct + a.cashPct).toBeCloseTo(100, 6);
  });

  it("totalEquity missing/0: falls back to raw cost-basis + cash without breaking invariants", () => {
    const a = deriveStripAllocation(
      [{ symbol: "AAA", quantity: 10, avg_cost: 20 }],
      50,
      0,
    );
    expect(a.denom).toBe(250); // 200 raw + 50 cash
    expect(a.investedValue).toBe(200);
    expect(a.safeCash).toBe(50);
    expect(a.investedPct + a.cashPct).toBeCloseTo(100, 6);
  });

  it("fuzz: any (cash, totalEquity, holdings) — pct sum to 100 and chip weights sum to investedPct", () => {
    const rnd = (seed: number) => {
      let s = seed;
      return () => {
        s = (s * 1_664_525 + 1_013_904_223) >>> 0;
        return s / 0xffffffff;
      };
    };
    const R = rnd(20260727);
    for (let i = 0; i < 200; i++) {
      const totalEquity = R() * 10_000;
      const cash = R() * 15_000; // deliberately can exceed equity
      const n = Math.floor(R() * 8);
      const holdings = Array.from({ length: n }, (_, k) => ({
        symbol: `S${k}`,
        quantity: R() * 100,
        avg_cost: R() * 200,
      }));
      const a = deriveStripAllocation(holdings, cash, totalEquity);
      // Pct sum to 100 within float tolerance (or both 0 if denom == 0).
      if (a.denom > 0) {
        expect(a.investedPct + a.cashPct).toBeCloseTo(100, 6);
        expect(a.investedPct).toBeGreaterThanOrEqual(0);
        expect(a.cashPct).toBeGreaterThanOrEqual(0);
        expect(a.investedPct).toBeLessThanOrEqual(100 + 1e-9);
        expect(a.cashPct).toBeLessThanOrEqual(100 + 1e-9);
      }
      // Chip values sum to investedValue; chip weights sum to investedPct.
      const chipSum = a.chips.reduce((s, c) => s + c.value, 0);
      const weightSum = a.chips.reduce((s, c) => s + c.weight, 0);
      expect(chipSum).toBeCloseTo(a.investedValue, 6);
      expect(weightSum).toBeCloseTo(a.investedPct, 6);
    }
  });
});
