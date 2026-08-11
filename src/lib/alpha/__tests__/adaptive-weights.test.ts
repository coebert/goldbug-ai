import { describe, expect, it } from "vitest";
import {
  applyAdaptiveWeights,
  computeModelMultipliers,
  credibility,
  describeAdaptiveWeights,
  multiplierFor,
  performanceSignal,
  MAX_MULT,
  MIN_MULT,
  FULL_CREDIBILITY_SAMPLES,
} from "../adaptive-weights";
import { effectiveWeightsForRegime } from "../regime-matrix";

describe("adaptive alpha weights", () => {
  it("credibility grows with samples and saturates at 1", () => {
    expect(credibility(0)).toBe(0);
    expect(credibility(FULL_CREDIBILITY_SAMPLES)).toBeCloseTo(1, 6);
    expect(credibility(FULL_CREDIBILITY_SAMPLES * 10)).toBe(1);
    expect(credibility(10)).toBeGreaterThan(0);
    expect(credibility(10)).toBeLessThan(credibility(30));
  });

  it("performance signal is bounded and edge-dominated", () => {
    expect(performanceSignal({ model_kind: "trend", samples: 50, hit_rate: null, avg_edge_bps: null })).toBe(0);
    const good = performanceSignal({ model_kind: "trend", samples: 50, hit_rate: 0.7, avg_edge_bps: 300 });
    const bad = performanceSignal({ model_kind: "trend", samples: 50, hit_rate: 0.2, avg_edge_bps: -300 });
    expect(good).toBe(1);
    expect(bad).toBe(-1);
    // edge weighs 60% vs hit rate 40%
    const mixed = performanceSignal({ model_kind: "carry", samples: 50, hit_rate: 0.3, avg_edge_bps: 120 });
    expect(mixed).toBeCloseTo(-1 * 0.4 + 1 * 0.6, 6);
  });

  it("never leaves the 0.5x-1.5x band", () => {
    const hot = multiplierFor({ model_kind: "trend", samples: 10_000, hit_rate: 1, avg_edge_bps: 10_000 });
    const cold = multiplierFor({ model_kind: "trend", samples: 10_000, hit_rate: 0, avg_edge_bps: -10_000 });
    expect(hot.multiplier).toBeCloseTo(MAX_MULT, 6);
    expect(cold.multiplier).toBeCloseTo(MIN_MULT, 6);
  });

  it("barely moves on thin evidence", () => {
    const thin = multiplierFor({ model_kind: "breakout", samples: 2, hit_rate: 1, avg_edge_bps: 500 });
    expect(thin.multiplier).toBeGreaterThan(1);
    expect(thin.multiplier).toBeLessThan(1.15);
  });

  it("defaults missing models to a neutral multiplier", () => {
    const mults = computeModelMultipliers([
      { model_kind: "trend", samples: 40, hit_rate: 0.7, avg_edge_bps: 200 },
    ]);
    expect(mults.trend.multiplier).toBeGreaterThan(1.2);
    expect(mults.carry.multiplier).toBe(1);
    expect(mults.quality.multiplier).toBe(1);
  });

  it("renormalises to 1 and keeps regime-disabled models at zero", () => {
    const base = effectiveWeightsForRegime("risk_off"); // carry + trend disabled
    const mults = computeModelMultipliers([
      { model_kind: "quality", samples: 40, hit_rate: 0.7, avg_edge_bps: 200 },
      { model_kind: "carry", samples: 40, hit_rate: 0.9, avg_edge_bps: 900 },
    ]);
    const { weights, rows } = applyAdaptiveWeights(base, mults);
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 9);
    for (const k of Object.keys(base) as Array<keyof typeof base>) {
      if (base[k] === 0) expect(weights[k]).toBe(0);
    }
    expect(rows.find((r) => r.model_kind === "quality")?.multiplier).toBeGreaterThan(1);
  });

  it("shifts weight toward the better-performing model", () => {
    const base = effectiveWeightsForRegime("low_vol");
    const { weights } = applyAdaptiveWeights(
      base,
      computeModelMultipliers([
        { model_kind: "trend", samples: 60, hit_rate: 0.72, avg_edge_bps: 240 },
        { model_kind: "mean_reversion", samples: 60, hit_rate: 0.3, avg_edge_bps: -180 },
      ]),
    );
    expect(weights.trend).toBeGreaterThan(base.trend);
    expect(weights.mean_reversion).toBeLessThan(base.mean_reversion);
  });

  it("is a no-op with no evidence", () => {
    const base = effectiveWeightsForRegime("trending");
    const { weights, rows } = applyAdaptiveWeights(base, computeModelMultipliers([]));
    for (const k of Object.keys(base) as Array<keyof typeof base>) {
      expect(weights[k]).toBeCloseTo(base[k], 9);
    }
    expect(describeAdaptiveWeights(rows)).toContain("no change");
  });
});
