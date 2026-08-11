import { describe, it, expect } from "vitest";
import {
  bootstrapRhoCI,
  bootstrapSeparationCI,
  diagnoseCalibrationFit,
  formatCalibrationDiagnostics,
  residualCorrelationErrors,
  rollingStability,
} from "../execution-correlation-diagnostics";
import { clusterSpilloverMatrix } from "../execution-cluster-spillover";
import { calibrateCorrelations, structureFromCalibration } from "../execution-correlation-calibration";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) =>
  Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

/** Two clusters of prices; `stressFrom` onwards everything couples hard. */
function makeTape(opts: { bars: number; seed: number; stressFrom?: number }) {
  const r = rng(opts.seed);
  const groups = new Map<string, string>();
  const symbols = ["A1", "A2", "A3", "B1", "B2", "B3"];
  for (const s of symbols) groups.set(s, s.startsWith("A") ? "alpha" : "beta");
  const prices = new Map<string, number[]>(symbols.map((s) => [s, [100]]));
  const stressFrom = opts.stressFrom ?? Number.POSITIVE_INFINITY;
  for (let t = 1; t < opts.bars; t++) {
    const stressed = t >= stressFrom;
    const market = gauss(r) * (stressed ? 3 : 1);
    const alpha = gauss(r);
    const beta = gauss(r);
    const wMarket = stressed ? 1.6 : 0.3;
    for (const s of symbols) {
      const cl = s.startsWith("A") ? alpha : beta;
      const shock = (wMarket * market + 0.9 * cl + 0.6 * gauss(r)) * 0.004;
      const series = prices.get(s)!;
      series.push(Math.max(1, series[series.length - 1]! * (1 + shock)));
    }
  }
  return { series: prices as ReadonlyMap<string, readonly number[]>, groups };
}

describe("rollingStability", () => {
  it("discounts overlapping windows in the effective sample size", () => {
    const s = rollingStability([0.3, 0.31, 0.29, 0.3, 0.32, 0.28], 12);
    expect(s.n).toBe(6);
    expect(s.effN).toBeCloseTo(0.5 > 6 / 12 ? 1 : Math.max(1, 6 / 12), 6);
    expect(s.effN).toBeLessThan(s.n);
  });

  it("reports drift and slope for a trending fit", () => {
    const rising = Array.from({ length: 20 }, (_, i) => 0.2 + i * 0.01);
    const s = rollingStability(rising, 1);
    expect(s.drift).toBeGreaterThan(0.09);
    expect(s.slopePerWindow).toBeCloseTo(0.01, 6);
    expect(s.autocorr1).toBeGreaterThan(0.8);
    expect(s.secondHalf).toBeGreaterThan(s.firstHalf);
  });

  it("is flat and low-variance for a constant fit", () => {
    const s = rollingStability([0.4, 0.4, 0.4, 0.4], 1);
    expect(s.sd).toBe(0);
    expect(s.iqr).toBe(0);
    expect(s.drift).toBe(0);
    expect(s.coefVar).toBe(0);
  });

  it("ignores non-finite entries", () => {
    const s = rollingStability([0.5, Number.NaN, 0.5], 1);
    expect(s.n).toBe(2);
    expect(s.mean).toBeCloseTo(0.5, 9);
  });
});

describe("bootstrapRhoCI", () => {
  const sample = Array.from({ length: 60 }, (_, i) => 0.4 + Math.sin(i) * 0.05);

  it("brackets the point estimate and is deterministic for a seed", () => {
    const a = bootstrapRhoCI(sample, { seed: 7, resamples: 300, blockSize: 4 });
    const b = bootstrapRhoCI(sample, { seed: 7, resamples: 300, blockSize: 4 });
    expect(a).toEqual(b);
    expect(a.lo).toBeLessThanOrEqual(a.estimate);
    expect(a.hi).toBeGreaterThanOrEqual(a.estimate);
    expect(a.estimate).toBeGreaterThan(0.3);
  });

  it("widens as the block size grows, because overlap is real information loss", () => {
    const tight = bootstrapRhoCI(sample, { seed: 3, resamples: 400, blockSize: 1 });
    const wide = bootstrapRhoCI(sample, { seed: 3, resamples: 400, blockSize: 20 });
    expect(wide.hi - wide.lo).toBeGreaterThan(tight.hi - tight.lo);
    expect(wide.effN).toBeLessThan(tight.effN);
  });

  it("degrades gracefully with too little data", () => {
    expect(bootstrapRhoCI([]).resamples).toBe(0);
    const one = bootstrapRhoCI([0.42]);
    expect(one.estimate).toBeCloseTo(0.42, 9);
    expect(one.lo).toBeCloseTo(0.42, 9);
  });
});

describe("bootstrapSeparationCI", () => {
  it("excludes zero when stress genuinely couples harder", () => {
    const calm = Array.from({ length: 40 }, (_, i) => 0.2 + (i % 5) * 0.01);
    const stress = Array.from({ length: 40 }, (_, i) => 0.7 + (i % 5) * 0.01);
    const sep = bootstrapSeparationCI(calm, stress, { seed: 11, resamples: 400 });
    expect(sep.estimate).toBeGreaterThan(0.4);
    expect(sep.lo).toBeGreaterThan(0);
  });

  it("includes zero when the two regimes look the same", () => {
    const r = rng(99);
    const calm = Array.from({ length: 40 }, () => 0.35 + gauss(r) * 0.05);
    const stress = Array.from({ length: 40 }, () => 0.35 + gauss(r) * 0.05);
    const sep = bootstrapSeparationCI(calm, stress, { seed: 5, resamples: 500 });
    expect(sep.lo).toBeLessThan(0);
    expect(sep.hi).toBeGreaterThan(0);
  });
});

describe("residualCorrelationErrors", () => {
  const { series, groups } = makeTape({ bars: 700, seed: 21, stressFrom: 420 });
  const opts = { groups, window: 40, step: 5 } as const;
  const cal = calibrateCorrelations(series, opts);
  const spill = clusterSpilloverMatrix(series, opts);

  it("scores every observed cluster pair in both regimes", () => {
    const report = residualCorrelationErrors(
      structureFromCalibration(cal, "contagion", groups), spill, "contagion",
    );
    const pairs = new Set(report.residuals.map((r) => `${r.a}|${r.b}|${r.regime}`));
    expect(pairs.size).toBe(report.residuals.length);
    expect(report.residuals.some((r) => r.a === r.b)).toBe(true);
    expect(report.residuals.some((r) => r.a !== r.b)).toBe(true);
    for (const r of report.residuals) {
      expect(r.error).toBeCloseTo(r.implied - r.realised, 12);
    }
  });

  it("reports a lower stress error for contagion than for a stress-blind blocks fit", () => {
    const contagion = residualCorrelationErrors(
      structureFromCalibration(cal, "contagion", groups), spill, "contagion",
    );
    const blocks = residualCorrelationErrors(
      structureFromCalibration(cal, "blocks", groups), spill, "blocks",
    );
    expect(contagion.rmseStress).toBeLessThan(blocks.rmseStress);
    expect(contagion.rmseCalm).toBeCloseTo(blocks.rmseCalm, 9);
  });

  it("is exactly zero when the structure reproduces the matrix", () => {
    const structure = structureFromCalibration(cal, "contagion", groups);
    const flat = {
      ...spill,
      cells: spill.cells.map((row, i) => row.map((cell, j) => ({
        ...cell,
        calm: i === j ? structure.withinRho : structure.acrossRho,
        stress: i === j ? structure.stressWithinRho : structure.stressAcrossRho,
      }))),
    };
    const report = residualCorrelationErrors(structure, flat, "contagion");
    expect(report.rmse).toBeCloseTo(0, 9);
    expect(report.bias).toBeCloseTo(0, 9);
    expect(report.weightedRmse).toBeCloseTo(0, 9);
  });

  it("skips unobserved cells rather than scoring them as zero", () => {
    const holed = {
      ...spill,
      cells: spill.cells.map((row, i) => row.map((cell, j) => (
        i === 0 && j === 1 ? { ...cell, calm: Number.NaN, stress: Number.NaN } : cell
      ))),
    };
    const report = residualCorrelationErrors(
      structureFromCalibration(cal, "blocks", groups), holed, "blocks",
    );
    expect(report.residuals.every((r) => Number.isFinite(r.realised))).toBe(true);
    expect(Number.isFinite(report.rmse)).toBe(true);
  });
});

describe("diagnoseCalibrationFit", () => {
  const stressed = makeTape({ bars: 900, seed: 4, stressFrom: 520 });
  const calmOnly = makeTape({ bars: 900, seed: 4 });
  const base = { window: 40, step: 5, resamples: 300, seed: 1 } as const;

  it("flags contagion when stress windows couple harder", () => {
    const d = diagnoseCalibrationFit(stressed.series, { ...base, groups: stressed.groups });
    expect(d.confidence.acrossSeparation.estimate).toBeGreaterThan(0);
    expect(d.contagionSupported).toBe(true);
    expect(d.bestFit).toBe("contagion");
  });

  it("does not claim contagion on a tape with no stress regime", () => {
    const d = diagnoseCalibrationFit(calmOnly.series, { ...base, groups: calmOnly.groups });
    expect(d.contagionSupported).toBe(false);
  });

  it("derives the block size from the window overlap", () => {
    const d = diagnoseCalibrationFit(stressed.series, { ...base, groups: stressed.groups });
    expect(d.overlapRatio).toBeCloseTo(8, 9);
    expect(d.confidence.calmWithin.effN).toBeLessThan(d.stability.calmWithin.n);
    expect(d.stability.within.effN).toBeCloseTo(d.stability.within.n / 8, 6);
  });

  it("is deterministic and renders a report covering all three diagnostics", () => {
    const opts = { ...base, groups: stressed.groups };
    const a = diagnoseCalibrationFit(stressed.series, opts);
    const b = diagnoseCalibrationFit(stressed.series, opts);
    expect(formatCalibrationDiagnostics(a)).toBe(formatCalibrationDiagnostics(b));
    const text = formatCalibrationDiagnostics(a);
    expect(text).toContain("Rolling-fit stability");
    expect(text).toContain("Bootstrap confidence");
    expect(text).toContain("Residual correlation error");
    expect(a.structures.map((s) => s.kind)).toEqual(["blocks", "contagion"]);
  });

  it("honours a restricted structure list", () => {
    const d = diagnoseCalibrationFit(stressed.series, {
      ...base, groups: stressed.groups, kinds: ["blocks"],
    });
    expect(d.structures).toHaveLength(1);
    expect(d.bestFit).toBe("blocks");
  });
});
