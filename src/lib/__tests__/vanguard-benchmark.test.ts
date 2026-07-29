import { describe, it, expect } from "vitest";
import {
  attributeAlpha,
  benchmarkValueAt,
  compareToVanguard,
  compound,
  portfolioTWR,
  simulateAlphaAtRiskLevels,
  VANGUARD_CAGR,
} from "@/lib/vanguard-benchmark";

describe("vanguard-benchmark", () => {
  it("compounds principal at the expected CAGR", () => {
    const v = compound(1000, 365);
    expect(v).toBeCloseTo(1000 * (1 + VANGUARD_CAGR), 4);
  });

  it("handles empty equity gracefully", () => {
    const cmp = compareToVanguard(1000, []);
    expect(cmp.portfolioValue).toBe(1000);
    expect(cmp.benchmarkValue).toBe(1000);
    expect(cmp.alphaPct).toBe(0);
  });

  it("computes alpha vs a passive Vanguard 60/40", () => {
    const cmp = compareToVanguard(
      1000,
      [
        { snapshot_date: "2025-01-01", total_value: 1000 },
        { snapshot_date: "2026-01-01", total_value: 1100 }, // +10% in a year
      ],
    );
    // Passive would return ~5.5%, so portfolio alpha ≈ +4.5%.
    expect(cmp.portfolioReturnPct).toBeCloseTo(10, 2);
    expect(cmp.benchmarkReturnPct).toBeCloseTo(VANGUARD_CAGR * 100, 2);
    expect(cmp.alphaPct).toBeCloseTo(10 - VANGUARD_CAGR * 100, 2);
  });

  it("compounds mid-run deposits from their own date", () => {
    const v = benchmarkValueAt(
      1000,
      "2025-01-01",
      [{ date: "2025-07-01", amount: 500 }],
      "2026-01-01",
    );
    // 1000 for full year + 500 for ~half year.
    const expected =
      1000 * (1 + VANGUARD_CAGR) +
      500 * Math.pow(1 + VANGUARD_CAGR, (365 - 181) / 365);
    // Loose tolerance since day counts vary slightly.
    expect(v).toBeGreaterThan(expected - 2);
    expect(v).toBeLessThan(expected + 2);
  });

  it("nets deposits into the contributed base for portfolio return %", () => {
    const cmp = compareToVanguard(
      1000,
      [
        { snapshot_date: "2025-01-01", total_value: 1000 },
        { snapshot_date: "2026-01-01", total_value: 1600 },
      ],
      [{ date: "2025-07-01", amount: 500 }],
    );
    // Contributed = 1500, final = 1600 → +6.67%.
    expect(cmp.contributed).toBe(1500);
    expect(cmp.portfolioReturnPct).toBeCloseTo(((1600 - 1500) / 1500) * 100, 2);
  });

  it("computes time-weighted return that nets out mid-run deposits", () => {
    const twr = portfolioTWR(
      [
        { snapshot_date: "2025-01-01", total_value: 1000 },
        { snapshot_date: "2025-07-01", total_value: 1600 }, // +100 skill after 500 deposit
        { snapshot_date: "2026-01-01", total_value: 1760 }, // +10% on 1600
      ],
      [{ date: "2025-06-15", amount: 500 }],
    );
    // seg1: (1600 - 500)/1000 - 1 = 0.10; seg2: 1760/1600 - 1 = 0.10 → 1.21 - 1
    expect(twr).toBeCloseTo(0.21, 4);
  });

  it("decomposes alpha into timing, allocation, and deposit-timing that sum to total", () => {
    const equity = [
      { snapshot_date: "2025-01-01", total_value: 1000 },
      { snapshot_date: "2026-01-01", total_value: 1600 },
    ];
    const deposits = [{ date: "2025-07-01", amount: 500 }];
    const cmp = compareToVanguard(1000, equity, deposits);
    const attr = attributeAlpha(cmp, equity, deposits);
    // Components must reconcile to total currency alpha.
    expect(attr.timing + attr.allocation + attr.depositTiming).toBeCloseTo(
      cmp.alphaCcy,
      6,
    );
    // Portfolio TWR is positive here, so timing skill should be positive.
    expect(attr.timing).toBeGreaterThan(0);
    // Late deposit in a rising benchmark hurts the passive baseline →
    // depositTiming (lump-sum − actual passive) is positive.
    expect(attr.depositTiming).toBeGreaterThan(0);
  });
});
