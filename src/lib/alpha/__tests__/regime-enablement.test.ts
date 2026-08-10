// Phase 1 — verify regime-based on/off gating for strategy weights.
import { describe, it, expect } from "vitest";
import {
  enabledStrategiesForRegime,
  effectiveWeightsForRegime,
  weightsForRegime,
} from "../regime-matrix";

describe("enabledStrategiesForRegime", () => {
  it("disables trend + mean_reversion in risk_off", () => {
    const e = enabledStrategiesForRegime("risk_off");
    expect(e.trend).toBe(false);
    expect(e.mean_reversion).toBe(false);
    expect(e.quality).toBe(true);
  });
  it("disables carry in risk_on and trending", () => {
    expect(enabledStrategiesForRegime("risk_on").carry).toBe(false);
    expect(enabledStrategiesForRegime("trending").carry).toBe(false);
  });
  it("keeps quality on in every regime", () => {
    for (const r of ["risk_on", "risk_off", "high_vol", "low_vol", "trending", "range_bound", "unknown"]) {
      expect(enabledStrategiesForRegime(r).quality).toBe(true);
    }
  });
});

describe("effectiveWeightsForRegime", () => {
  it("zeros disabled strategies", () => {
    const w = effectiveWeightsForRegime("risk_off");
    expect(w.trend).toBe(0);
    expect(w.mean_reversion).toBe(0);
  });
  it("renormalises enabled weights to sum to 1", () => {
    for (const r of ["risk_on", "risk_off", "high_vol", "low_vol", "trending", "range_bound"]) {
      const w = effectiveWeightsForRegime(r);
      const s = w.trend + w.mean_reversion + w.quality + w.carry + w.breakout;
      expect(s).toBeCloseTo(1, 6);
    }
  });
  it("redistributes disabled weight — quality share in risk_off > raw share", () => {
    const raw = weightsForRegime("risk_off");
    const eff = effectiveWeightsForRegime("risk_off");
    expect(eff.quality).toBeGreaterThan(raw.quality);
  });
  it("passes through unchanged in unknown regime (all enabled)", () => {
    const raw = weightsForRegime("unknown");
    const eff = effectiveWeightsForRegime("unknown");
    for (const k of ["trend", "mean_reversion", "quality", "carry", "breakout"] as const) {
      expect(eff[k]).toBeCloseTo(raw[k], 6);
    }
  });
});
