import { describe, it, expect } from "vitest";
import {
  attributeAlpha,
  benchmarkValueAt,
  compareToVanguard,
  compound,
  portfolioTWR,
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
});
