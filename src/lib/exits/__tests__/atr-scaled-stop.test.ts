import { describe, it, expect } from "vitest";
import { atrScaledStopPct } from "../atr-scaled-stop";

const base = { fixedStopPct: 0.1, atrPct: 0.015, atrMult: 2.5, floorPct: 0.03, enabled: true };

describe("atrScaledStopPct", () => {
  it("tightens the stop for a quiet mega-cap (the AAPL case)", () => {
    const r = atrScaledStopPct(base);
    expect(r.effectiveStopPct).toBeCloseTo(0.0375, 10);
    expect(r.scaled).toBe(true);
    // AAPL fell 10.88%: it would have exited far earlier.
    expect(0.1088).toBeGreaterThan(r.effectiveStopPct);
  });

  it("never widens beyond the configured fixed stop", () => {
    const r = atrScaledStopPct({ ...base, atrPct: 0.08 });
    expect(r.effectiveStopPct).toBe(0.1);
    expect(r.scaled).toBe(false);
  });

  it("respects the noise floor", () => {
    const r = atrScaledStopPct({ ...base, atrPct: 0.002 });
    expect(r.effectiveStopPct).toBeCloseTo(0.03, 10);
    expect(r.scaled).toBe(true);
  });

  it("clamps the floor to the fixed stop when the floor is larger", () => {
    const r = atrScaledStopPct({ ...base, fixedStopPct: 0.02, atrPct: 0.001 });
    expect(r.effectiveStopPct).toBeCloseTo(0.02, 10);
  });

  it("falls back to the fixed stop when disabled or ATR is unknown", () => {
    expect(atrScaledStopPct({ ...base, enabled: false }).effectiveStopPct).toBe(0.1);
    expect(atrScaledStopPct({ ...base, atrPct: 0 }).effectiveStopPct).toBe(0.1);
    expect(atrScaledStopPct({ ...base, atrMult: 0 }).effectiveStopPct).toBe(0.1);
  });

  it("returns 0 when stops are switched off", () => {
    const r = atrScaledStopPct({ ...base, fixedStopPct: 0 });
    expect(r.effectiveStopPct).toBe(0);
    expect(r.note).toMatch(/no stop-loss/);
  });

  it("is total and monotonic in ATR", () => {
    let prev = 0;
    for (const atrPct of [0, 0.001, 0.005, 0.01, 0.02, 0.04, 0.5, NaN]) {
      const r = atrScaledStopPct({ ...base, atrPct });
      expect(Number.isFinite(r.effectiveStopPct)).toBe(true);
      expect(r.effectiveStopPct).toBeGreaterThanOrEqual(0);
      expect(r.effectiveStopPct).toBeLessThanOrEqual(0.1);
      if (Number.isFinite(atrPct) && atrPct > 0) {
        expect(r.effectiveStopPct).toBeGreaterThanOrEqual(prev);
        prev = r.effectiveStopPct;
      }
    }
  });
});
