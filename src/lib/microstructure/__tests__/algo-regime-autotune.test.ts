import { describe, it, expect } from "vitest";
import {
  suggestConfigAdjustments,
  MIN_SAMPLES_FOR_TUNING,
} from "@/lib/microstructure/algo-regime-autotune";
import { DEFAULT_ALGO_REGIME_CONFIG } from "@/lib/microstructure/algo-regime";
import type { CalibrationReport } from "@/lib/microstructure/algo-regime-calibration";

function mkReport(overrides: Partial<CalibrationReport> = {}): CalibrationReport {
  return {
    matched: 50,
    unmatched: 0,
    monotone: true,
    perTier: [
      { tier: "normal",   count: 30, meanReturn:  0.002, stdReturn: 0.01, hitRate: 0.6, worstReturn: -0.02 },
      { tier: "elevated", count: 15, meanReturn:  0.000, stdReturn: 0.02, hitRate: 0.4, worstReturn: -0.03 },
      { tier: "extreme",  count:  5, meanReturn: -0.010, stdReturn: 0.03, hitRate: 0.3, worstReturn: -0.05 },
    ],
    ...overrides,
  };
}

describe("suggestConfigAdjustments", () => {
  it("refuses to tune with insufficient samples", () => {
    const r = suggestConfigAdjustments(mkReport({ matched: MIN_SAMPLES_FOR_TUNING - 1 }));
    expect(r.changed).toBe(false);
    expect(r.notes[0]).toMatch(/insufficient sample/);
  });

  it("loosens (lowers volBurstRatio, raises vacuumRatio) on inverted ladder", () => {
    const inverted = mkReport({
      monotone: false,
      perTier: [
        { tier: "normal",   count: 25, meanReturn:  0.001, stdReturn: 0.01, hitRate: 0.5, worstReturn: -0.01 },
        { tier: "elevated", count: 15, meanReturn: -0.010, stdReturn: 0.02, hitRate: 0.3, worstReturn: -0.04 },
        { tier: "extreme",  count:  5, meanReturn:  0.005, stdReturn: 0.03, hitRate: 0.6, worstReturn: -0.02 },
      ],
    });
    const r = suggestConfigAdjustments(inverted);
    expect(r.changed).toBe(true);
    expect(r.suggested.volBurstRatio).toBeLessThan(DEFAULT_ALGO_REGIME_CONFIG.volBurstRatio);
    expect(r.suggested.liquidityVacuumRatio).toBeGreaterThan(
      DEFAULT_ALGO_REGIME_CONFIG.liquidityVacuumRatio,
    );
  });

  it("tightens volBurstRatio when the ladder is healthy with big separation", () => {
    const healthy = mkReport({
      monotone: true,
      perTier: [
        { tier: "normal",   count: 40, meanReturn:  0.005, stdReturn: 0.01, hitRate: 0.7, worstReturn: -0.02 },
        { tier: "elevated", count: 20, meanReturn:  0.000, stdReturn: 0.02, hitRate: 0.5, worstReturn: -0.03 },
        { tier: "extreme",  count: 12, meanReturn: -0.010, stdReturn: 0.03, hitRate: 0.3, worstReturn: -0.05 },
      ],
    });
    const r = suggestConfigAdjustments(healthy);
    expect(r.changed).toBe(true);
    expect(r.suggested.volBurstRatio).toBeGreaterThan(DEFAULT_ALGO_REGIME_CONFIG.volBurstRatio);
  });

  it("loosens when extreme never fires but normal has negative mean", () => {
    const missing = mkReport({
      monotone: true,
      perTier: [
        { tier: "normal",   count: 40, meanReturn: -0.002, stdReturn: 0.01, hitRate: 0.4, worstReturn: -0.03 },
        { tier: "elevated", count:  8, meanReturn: -0.005, stdReturn: 0.02, hitRate: 0.3, worstReturn: -0.04 },
        { tier: "extreme",  count:  1, meanReturn: -0.010, stdReturn: 0.00, hitRate: 0.0, worstReturn: -0.01 },
      ],
    });
    const r = suggestConfigAdjustments(missing);
    expect(r.changed).toBe(true);
    expect(r.suggested.volBurstRatio).toBeLessThan(DEFAULT_ALGO_REGIME_CONFIG.volBurstRatio);
  });

  it("respects clamps and never runs volBurstRatio out of bounds", () => {
    const badReport = mkReport({
      monotone: false,
      perTier: [
        { tier: "normal",   count: 25, meanReturn:  0.001, stdReturn: 0.01, hitRate: 0.5, worstReturn: -0.01 },
        { tier: "elevated", count: 15, meanReturn: -0.010, stdReturn: 0.02, hitRate: 0.3, worstReturn: -0.04 },
        { tier: "extreme",  count:  5, meanReturn:  0.005, stdReturn: 0.03, hitRate: 0.6, worstReturn: -0.02 },
      ],
    });
    const pinned = { ...DEFAULT_ALGO_REGIME_CONFIG, volBurstRatio: 1.5, liquidityVacuumRatio: 0.7 };
    const r = suggestConfigAdjustments(badReport, pinned);
    expect(r.suggested.volBurstRatio).toBeGreaterThanOrEqual(1.5);
    expect(r.suggested.liquidityVacuumRatio).toBeLessThanOrEqual(0.7);
  });
});
