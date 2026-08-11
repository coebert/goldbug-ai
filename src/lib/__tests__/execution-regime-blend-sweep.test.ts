import { describe, expect, it } from "vitest";
import {
  barStressWeight,
  calibrateCorrelations,
  rollingCorrelationWindows,
  windowStressWeight,
  fisherWeightedMean,
} from "@/lib/execution-correlation-calibration";
import {
  DEFAULT_BLEND_GRID,
  formatRegimeBlendSweep,
  spearman,
  sweepRegimeBlend,
} from "@/lib/execution-regime-blend-sweep";

// A two-cluster tape: `a*` co-move, `b*` co-move, and during a stress patch in
// the middle every name co-moves. Deterministic, so the sweep is reproducible.
function tape(bars = 400): {
  series: Map<string, number[]>;
  volZ: number[];
  stressFrom: number;
  stressTo: number;
} {
  const symbols = ["a1", "a2", "a3", "b1", "b2", "b3"];
  const series = new Map<string, number[]>(symbols.map((s) => [s, [100]]));
  const volZ: number[] = [0];
  const stressFrom = Math.floor(bars * 0.45);
  const stressTo = Math.floor(bars * 0.6);
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };

  for (let i = 1; i < bars; i++) {
    const stressed = i >= stressFrom && i < stressTo;
    const market = rnd() * (stressed ? 0.05 : 0.004);
    const clusterA = rnd() * 0.01;
    const clusterB = rnd() * 0.01;
    for (const s of symbols) {
      const cluster = s.startsWith("a") ? clusterA : clusterB;
      const idio = rnd() * 0.006;
      const prev = series.get(s)!.at(-1)!;
      series.get(s)!.push(prev * (1 + market + cluster + idio));
    }
    // Ramp the z-score in and out so windows straddle the threshold.
    const edge = stressed
      ? Math.min(i - stressFrom, stressTo - i) / 6
      : -Math.min(Math.abs(i - stressFrom), Math.abs(i - stressTo)) / 20;
    volZ.push(Math.max(-1.2, Math.min(3, 1.4 + edge)));
  }
  return { series, volZ, stressFrom, stressTo };
}

describe("regime membership weights", () => {
  it("blend 0 reproduces the hard threshold exactly", () => {
    expect(barStressWeight(1.49, 1.5, 0)).toBe(0);
    expect(barStressWeight(1.5, 1.5, 0)).toBe(1);
    expect(windowStressWeight(0.24, 0.25, 0)).toBe(0);
    expect(windowStressWeight(0.25, 0.25, 0)).toBe(1);
  });

  it("a positive blend ramps a near-miss bar in fractionally", () => {
    expect(barStressWeight(1.5, 1.5, 0.5)).toBeCloseTo(0.5, 6);
    expect(barStressWeight(1.25, 1.5, 0.5)).toBeCloseTo(0.25, 6);
    expect(barStressWeight(2.1, 1.5, 0.5)).toBe(1);
    expect(barStressWeight(0.9, 1.5, 0.5)).toBe(0);
  });

  it("window weights ramp around minStressShare proportionally", () => {
    expect(windowStressWeight(0.125, 0.25, 1)).toBeCloseTo(0.25, 6);
    expect(windowStressWeight(0.25, 0.25, 1)).toBeCloseTo(0.5, 6);
    expect(windowStressWeight(0.5, 0.25, 1)).toBe(1);
  });

  it("a NaN z-score never counts as stressed", () => {
    expect(barStressWeight(Number.NaN, 1.5, 0.5)).toBe(0);
  });
});

describe("weighted pooling", () => {
  it("collapses to the unweighted Fisher mean at unit weights", () => {
    const rhos = [0.2, 0.5, 0.8];
    expect(fisherWeightedMean(rhos, [1, 1, 1])).toBeCloseTo(
      Math.tanh(rhos.reduce((a, r) => a + Math.atanh(r), 0) / 3),
      9,
    );
  });

  it("ignores zero-weight and non-finite entries", () => {
    expect(fisherWeightedMean([0.9, 0.1], [0, 1])).toBeCloseTo(0.1, 9);
    expect(fisherWeightedMean([Number.NaN, 0.4], [1, 1])).toBeCloseTo(0.4, 9);
    expect(fisherWeightedMean([0.4], [0])).toBeNaN();
  });
});

describe("calibration under a blend", () => {
  const { series, volZ } = tape();
  const base = { volZ, window: 60, step: 5, stressZ: 1.5, minStressShare: 0.25 };

  it("blend 0 is bit-identical to the pre-blend behaviour", () => {
    const hard = rollingCorrelationWindows(series, base);
    for (const w of hard) {
      expect(w.stressWeight).toBe(w.stressed ? 1 : 0);
      expect(w.stressed).toBe(w.stressShare >= 0.25);
    }
    const cal = calibrateCorrelations(series, base);
    expect(cal.blend).toBe(0);
    expect(cal.stressMass).toBe(hard.filter((w) => w.stressed).length);
  });

  it("a blend creates partially-stressed windows without changing the window count", () => {
    const hard = rollingCorrelationWindows(series, base);
    const soft = rollingCorrelationWindows(series, { ...base, blend: 0.5 });
    expect(soft).toHaveLength(hard.length);
    expect(soft.some((w) => w.stressWeight > 0 && w.stressWeight < 1)).toBe(true);
  });

  it("keeps pooled ρ inside [-1, 1] and stress mass inside the window count", () => {
    for (const blend of DEFAULT_BLEND_GRID) {
      const cal = calibrateCorrelations(series, { ...base, blend });
      expect(cal.stressMass).toBeGreaterThanOrEqual(0);
      expect(cal.stressMass).toBeLessThanOrEqual(cal.windows.length);
      for (const rho of [
        cal.calm.within.rho, cal.calm.across.rho,
        cal.stress.within.rho, cal.stress.across.rho,
      ]) {
        if (Number.isFinite(rho)) {
          expect(rho).toBeGreaterThanOrEqual(-1);
          expect(rho).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("is deterministic — the same blend refits to the same numbers", () => {
    const a = calibrateCorrelations(series, { ...base, blend: 0.3 });
    const b = calibrateCorrelations(series, { ...base, blend: 0.3 });
    expect(a.stress.within.rho).toBe(b.stress.within.rho);
    expect(a.stressMass).toBe(b.stressMass);
  });
});

describe("spearman", () => {
  it("is +1 for a monotone increase and -1 for a decrease", () => {
    expect(spearman([0, 1, 2, 3], [1, 2, 5, 9])).toBeCloseTo(1, 9);
    expect(spearman([0, 1, 2, 3], [9, 5, 2, 1])).toBeCloseTo(-1, 9);
  });

  it("is 0 when one side is flat and NaN when there is nothing to rank", () => {
    expect(spearman([0, 1, 2], [4, 4, 4])).toBe(0);
    expect(spearman([0, 1], [1, 2])).toBeNaN();
  });
});

describe("sweepRegimeBlend", () => {
  const { series, volZ } = tape();
  const opts = {
    volZ, window: 60, step: 5, stressZ: 1.5, minStressShare: 0.25,
    resamples: 60, seed: 11,
  };

  it("fits one point per blend, sorted and de-duplicated", () => {
    const s = sweepRegimeBlend(series, { ...opts, blends: [0.5, 0, 0.5, 0.25] });
    expect(s.points.map((p) => p.blend)).toEqual([0, 0.25, 0.5]);
    expect(s.points[0]!.setting).toBe("binary");
    expect(s.points[2]!.setting).toBe("ramp ±0.50z");
  });

  it("holds the tape fixed: every blend sees the same windows", () => {
    const s = sweepRegimeBlend(series, opts);
    const counts = new Set(s.points.map((p) => p.windows));
    expect(counts.size).toBe(1);
  });

  it("softening the boundary only ever adds partial windows", () => {
    const s = sweepRegimeBlend(series, opts);
    expect(s.points[0]!.partialWindows).toBe(0);
    expect(s.points.at(-1)!.partialWindows).toBeGreaterThan(0);
  });

  it("reports a spread per metric with the blend that produced each end", () => {
    const s = sweepRegimeBlend(series, opts);
    const sp = s.spreads.find((x) => x.metric === "stress within ρ")!;
    expect(sp.range).toBeGreaterThanOrEqual(0);
    expect(s.points.map((p) => p.blend)).toContain(sp.argMax);
    expect(s.spreads.map((x) => x.metric)).toContain("rmse contagion");
  });

  it("calls the run fragile when the structure verdict flips across blends", () => {
    const s = sweepRegimeBlend(series, opts);
    const flips = !s.bestFitStable || !s.contagionVerdictStable;
    expect(s.verdict === "fragile").toBe(flips);
    if (!flips) expect(["stable", "sensitive"]).toContain(s.verdict);
  });

  it("picks the blend with the lowest residual error", () => {
    const s = sweepRegimeBlend(series, opts);
    const best = s.points
      .map((p) => ({
        blend: p.blend,
        rmse: Math.min(...p.residuals.map((r) => r.weightedRmse)),
      }))
      .sort((a, b) => a.rmse - b.rmse)[0]!;
    expect(s.bestBlend).toBe(best.blend);
  });

  it("is deterministic across repeated sweeps", () => {
    const a = sweepRegimeBlend(series, opts);
    const b = sweepRegimeBlend(series, opts);
    expect(a.points.map((p) => p.stressWithin)).toEqual(b.points.map((p) => p.stressWithin));
    expect(a.verdict).toBe(b.verdict);
  });

  it("survives a tape with no stress at all", () => {
    const flat = new Map([...series].map(([k, v]) => [k, v]));
    const s = sweepRegimeBlend(flat, { ...opts, volZ: volZ.map(() => -3) });
    expect(s.points.every((p) => p.stressMass === 0)).toBe(true);
    expect(() => formatRegimeBlendSweep(s)).not.toThrow();
  });

  it("prints every blend and the verdict", () => {
    const out = formatRegimeBlendSweep(sweepRegimeBlend(series, opts));
    expect(out).toContain("binary");
    expect(out).toContain("ramp ±1.00z");
    expect(out).toMatch(/Verdict: (STABLE|SENSITIVE|FRAGILE)/);
    expect(out).toContain("Spread attributable to the blend choice alone");
  });
});
