import { describe, it, expect } from "vitest";
import {
  suggestConfigAdjustments,
  getClampsForRisk,
} from "@/lib/microstructure/algo-regime-autotune";
import { DEFAULT_ALGO_REGIME_CONFIG } from "@/lib/microstructure/algo-regime";
import type { CalibrationReport } from "@/lib/microstructure/algo-regime-calibration";

function invertedReport(): CalibrationReport {
  return {
    matched: 50,
    unmatched: 0,
    monotone: false,
    perTier: [
      { tier: "normal",   count: 25, meanReturn:  0.001, stdReturn: 0.01, hitRate: 0.5, worstReturn: -0.01 },
      { tier: "elevated", count: 15, meanReturn: -0.010, stdReturn: 0.02, hitRate: 0.3, worstReturn: -0.04 },
      { tier: "extreme",  count: 10, meanReturn:  0.005, stdReturn: 0.03, hitRate: 0.6, worstReturn: -0.02 },
    ],
  };
}

describe("suggestConfigAdjustments — risk-level scaling", () => {
  it("aggressive step exceeds balanced step, which exceeds conservative step", () => {
    const r = invertedReport();
    const cons = suggestConfigAdjustments(r, DEFAULT_ALGO_REGIME_CONFIG, "conservative");
    const bal  = suggestConfigAdjustments(r, DEFAULT_ALGO_REGIME_CONFIG, "balanced");
    const agg  = suggestConfigAdjustments(r, DEFAULT_ALGO_REGIME_CONFIG, "aggressive");
    const dCons = DEFAULT_ALGO_REGIME_CONFIG.volBurstRatio - cons.suggested.volBurstRatio;
    const dBal  = DEFAULT_ALGO_REGIME_CONFIG.volBurstRatio - bal.suggested.volBurstRatio;
    const dAgg  = DEFAULT_ALGO_REGIME_CONFIG.volBurstRatio - agg.suggested.volBurstRatio;
    expect(dCons).toBeGreaterThan(0);
    expect(dBal).toBeGreaterThan(dCons);
    expect(dAgg).toBeGreaterThan(dBal);
  });

  it("conservative floor is stricter than aggressive floor", () => {
    expect(getClampsForRisk("conservative").volBurstRatio.min)
      .toBeGreaterThan(getClampsForRisk("aggressive").volBurstRatio.min);
    expect(getClampsForRisk("conservative").liquidityVacuumRatio.max)
      .toBeLessThan(getClampsForRisk("aggressive").liquidityVacuumRatio.max);
  });

  it("caps cumulative drift so many loosen cycles cannot invert the ladder", () => {
    const drift = getClampsForRisk("conservative").maxDrift.volBurstRatio;
    const floor = DEFAULT_ALGO_REGIME_CONFIG.volBurstRatio - drift;
    let cur = { ...DEFAULT_ALGO_REGIME_CONFIG };
    for (let i = 0; i < 50; i++) {
      cur = suggestConfigAdjustments(invertedReport(), cur, "conservative").suggested;
    }
    // After many cycles the value must not fall below (default − maxDrift).
    expect(cur.volBurstRatio).toBeGreaterThanOrEqual(floor - 1e-9);
    // And must still be ≥ the hard min.
    expect(cur.volBurstRatio).toBeGreaterThanOrEqual(
      getClampsForRisk("conservative").volBurstRatio.min - 1e-9,
    );
  });

  it("aggressive drift cap is wider than conservative drift cap", () => {
    expect(getClampsForRisk("aggressive").maxDrift.volBurstRatio)
      .toBeGreaterThan(getClampsForRisk("conservative").maxDrift.volBurstRatio);
  });

  it("notes surface the active risk level", () => {
    const r = suggestConfigAdjustments(invertedReport(), DEFAULT_ALGO_REGIME_CONFIG, "aggressive");
    expect(r.notes.join(" ")).toMatch(/\[aggressive\]/);
  });
});
