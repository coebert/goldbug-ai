import { describe, expect, it } from "vitest";
import {
  buildConcentrationAlert,
  DEFAULT_CONCENTRATION_CAP,
  SHOCK_MOVE,
} from "../concentration-alert";

const pos = (
  symbol: string,
  valueBase: number,
  quantity = 100,
  fractional = false,
) => ({ holdingId: `h-${symbol}`, symbol, quantity, valueBase, fractional });

describe("buildConcentrationAlert", () => {
  it("returns null when every position is inside the cap", () => {
    const a = buildConcentrationAlert({
      nav: 10_000,
      positions: [pos("AAA", 1_400), pos("BBB", 1_000)],
    });
    expect(a).toBeNull();
  });

  it("returns null for a zero or missing NAV", () => {
    expect(buildConcentrationAlert({ nav: 0, positions: [pos("AAA", 5_000)] })).toBeNull();
    expect(
      buildConcentrationAlert({ nav: Number.NaN, positions: [pos("AAA", 5_000)] }),
    ).toBeNull();
  });

  it("flags a breach and sizes the trim back inside the cap", () => {
    const a = buildConcentrationAlert({
      nav: 10_000,
      // 30% of NAV against a 15% cap.
      positions: [pos("MKS", 3_000, 775), pos("VUSA", 2_000, 21)],
    });
    expect(a).not.toBeNull();
    expect(a!.breaches).toHaveLength(1);
    const b = a!.breaches[0];
    expect(b.symbol).toBe("MKS");
    expect(b.weight).toBeCloseTo(0.3, 6);
    expect(b.capPct).toBe(DEFAULT_CONCENTRATION_CAP);
    expect(b.excessBase).toBeCloseTo(1_500, 6);
    // Target is cap − 1pp buffer = 14% => sell 1,600 of 3,000 = 53.3% → 54%.
    expect(b.trimPercent).toBe(54);
    expect(b.weightAfter).toBeLessThan(DEFAULT_CONCENTRATION_CAP);
  });

  it("rounds the suggested percentage up so the sale clears the cap", () => {
    const a = buildConcentrationAlert({
      nav: 10_000,
      positions: [pos("AAA", 1_700, 1_000)],
    });
    const b = a!.breaches[0];
    expect(Number.isInteger(b.trimPercent)).toBe(true);
    expect(b.valueBase - b.trimBase).toBeLessThanOrEqual(
      DEFAULT_CONCENTRATION_CAP * 10_000 + 1e-9,
    );
  });

  it("sells whole units for equities and fractions for crypto", () => {
    const equity = buildConcentrationAlert({
      nav: 10_000,
      positions: [pos("AAA", 3_000, 7)],
    })!.breaches[0];
    expect(Number.isInteger(equity.trimQuantity)).toBe(true);
    expect(equity.trimQuantity).toBe(Math.floor(7 * (equity.trimPercent / 100)));

    const crypto = buildConcentrationAlert({
      nav: 10_000,
      positions: [pos("BTC", 3_000, 0.045, true)],
    })!.breaches[0];
    expect(crypto.trimQuantity).toBeGreaterThan(0);
    expect(crypto.trimQuantity).toBeLessThan(0.045);
  });

  it("reports the executable trim, not the ideal one, when rounding bites", () => {
    // 3 units worth 3,000 → ideal 54% is 1.62 units, only 1 whole unit sells.
    const b = buildConcentrationAlert({
      nav: 10_000,
      positions: [pos("AAA", 3_000, 3)],
    })!.breaches[0];
    expect(b.trimQuantity).toBe(1);
    expect(b.trimBase).toBeCloseTo(1_000, 6);
    expect(b.weightAfter).toBeCloseTo(0.2, 6);
  });

  it("orders breaches by weight and aggregates risk impact", () => {
    const a = buildConcentrationAlert({
      nav: 10_000,
      positions: [pos("SMALL", 1_800, 100), pos("BIG", 4_000, 100), pos("OK", 1_000, 100)],
    })!;
    expect(a.breaches.map((b) => b.symbol)).toEqual(["BIG", "SMALL"]);
    expect(a.impact.topWeightBefore).toBeCloseTo(0.4, 6);
    expect(a.impact.topWeightAfter).toBeLessThanOrEqual(DEFAULT_CONCENTRATION_CAP);
    expect(a.impact.hhiAfter).toBeLessThan(a.impact.hhiBefore);
    expect(a.impact.shockLossAfter).toBeLessThan(a.impact.shockLossBefore);
    expect(a.impact.shockLossBefore).toBeCloseTo((4_000 + 1_800) * SHOCK_MOVE, 6);
    expect(a.impact.totalTrimBase).toBeGreaterThan(0);
  });

  it("ignores positions that could not be valued", () => {
    const a = buildConcentrationAlert({
      nav: 10_000,
      positions: [pos("UNKNOWN", 0, 100), pos("AAA", 3_000, 100)],
    })!;
    expect(a.breaches.map((b) => b.symbol)).toEqual(["AAA"]);
  });

  it("honours a custom cap", () => {
    const a = buildConcentrationAlert({
      nav: 10_000,
      positions: [pos("AAA", 2_500, 100)],
      capPct: 0.3,
    });
    expect(a).toBeNull();
  });
});
