import { describe, it, expect } from "vitest";
import {
  calibrateFoldStructures,
  compareFoldFits,
  evaluateFoldFit,
  formatFitComparisons,
  formatFitSummaries,
  sliceSeriesWindow,
  summariseFoldFits,
  type FoldWindow,
} from "../execution-oos-calibration";
import { makeCorrelationStructure } from "../execution-correlation-structures";

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

const SYMBOLS = ["A1", "A2", "A3", "B1", "B2", "B3"];
const GROUPS = new Map(SYMBOLS.map((s) => [s, s.startsWith("A") ? "alpha" : "beta"]));

/**
 * Tape whose coupling regime changes over time: `couplingAt(t)` returns the
 * market-factor weight, so a calibration fitted on one stretch can be right or
 * wrong about the next one by construction.
 */
function makeTape(bars: number, seed: number, couplingAt: (t: number) => number) {
  const r = rng(seed);
  const prices = new Map<string, number[]>(SYMBOLS.map((s) => [s, [100]]));
  const volZ = [0];
  for (let t = 1; t < bars; t++) {
    const w = couplingAt(t);
    volZ.push(w > 1 ? 2.5 : 0);
    const market = gauss(r);
    const alpha = gauss(r);
    const beta = gauss(r);
    for (const s of SYMBOLS) {
      const cl = s.startsWith("A") ? alpha : beta;
      const shock = (w * market + 0.9 * cl + 0.6 * gauss(r)) * 0.004;
      const series = prices.get(s)!;
      series.push(Math.max(1, series[series.length - 1]! * (1 + shock)));
    }
  }
  return { series: prices as ReadonlyMap<string, readonly number[]>, volZ };
}

const foldsOver = (bars: number, train: number, test: number): FoldWindow[] => {
  const out: FoldWindow[] = [];
  let cursor = 0;
  while (cursor + train + test <= bars) {
    out.push({
      trainStart: cursor,
      trainEnd: cursor + train - 1,
      testStart: cursor + train,
      testEnd: cursor + train + test - 1,
    });
    cursor += test;
  }
  return out;
};

const OPTS = { groups: GROUPS, window: 40, step: 5 } as const;

describe("sliceSeriesWindow", () => {
  const series = new Map<string, number[]>([
    ["A1", [1, 2, 3, 4, 5, 6]],
    ["B1", [10, 20, 30, 40, 50, 60]],
    ["short", [1, 2]],
  ]);

  it("takes an inclusive bar window and copies the data", () => {
    const cut = sliceSeriesWindow(series, 1, 3);
    expect(cut.get("A1")).toEqual([2, 3, 4]);
    cut.get("A1")![0] = 999;
    expect(series.get("A1")![1]).toBe(2);
  });

  it("drops series too short to yield returns and clamps a negative start", () => {
    const cut = sliceSeriesWindow(series, -5, 2);
    expect(cut.has("short")).toBe(false);
    expect(cut.get("A1")).toEqual([1, 2, 3]);
  });
});

describe("calibrateFoldStructures", () => {
  const bars = 1200;
  const { series, volZ } = makeTape(bars, 3, (t) => (t > 800 ? 1.6 : 0.3));
  const folds = foldsOver(bars, 300, 100);

  it("fits one structure per fold using train bars only", () => {
    const rows = calibrateFoldStructures(series, folds, "contagion", { ...OPTS, volZ });
    expect(rows).toHaveLength(folds.length);
    expect(rows.map((r) => r.fold)).toEqual(folds.map((_, i) => i));
    for (const r of rows) {
      expect(r.kind).toBe("contagion");
      expect(r.trainWindows).toBeGreaterThan(0);
      expect(r.structure.withinRho).toBeGreaterThanOrEqual(0);
      expect(r.structure.withinRho).toBeLessThanOrEqual(1);
    }
  });

  it("does not peek at the future: early folds ignore the later coupling shift", () => {
    const early = calibrateFoldStructures(series, [folds[0]!], "contagion", { ...OPTS, volZ })[0]!;
    const late = calibrateFoldStructures(
      series, [folds[folds.length - 1]!], "contagion", { ...OPTS, volZ },
    )[0]!;
    expect(early.structure.stressWithinRho).toBeLessThan(late.structure.stressWithinRho);
    expect(early.stressStarved).toBe(true);
    expect(late.stressStarved).toBe(false);
  });

  it("falls back to the calm estimate rather than inventing a stress regime", () => {
    const calm = makeTape(700, 9, () => 0.3);
    const rows = calibrateFoldStructures(
      calm.series, foldsOver(700, 300, 100), "contagion", { ...OPTS, volZ: calm.volZ },
    );
    for (const r of rows) {
      expect(r.stressStarved).toBe(true);
      expect(r.structure.stressWithinRho).toBeCloseTo(r.structure.withinRho, 9);
    }
  });
});

describe("evaluateFoldFit", () => {
  const bars = 1200;
  const { series, volZ } = makeTape(bars, 5, (t) => (t > 700 ? 1.6 : 0.3));
  const folds = foldsOver(bars, 300, 100);
  const opts = { ...OPTS, volZ };

  it("scores in-sample and out-of-sample separately for every fold", () => {
    const rows = calibrateFoldStructures(series, folds, "contagion", opts);
    const fits = evaluateFoldFit(series, folds, (i) => rows[i]!.structure, opts);
    expect(fits).toHaveLength(folds.length);
    for (const f of fits) {
      expect(f.inSampleRmse).toBeGreaterThanOrEqual(0);
      expect(f.outOfSampleRmse).toBeGreaterThanOrEqual(0);
      expect(f.drift).toBeCloseTo(f.outOfSampleRmse - f.inSampleRmse, 12);
      expect(f.testResiduals.residuals.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic", () => {
    const fixed = makeCorrelationStructure({ kind: "global", rho: 0.5, groups: GROUPS });
    const a = evaluateFoldFit(series, folds, () => fixed, opts);
    const b = evaluateFoldFit(series, folds, () => fixed, opts);
    expect(a.map((f) => f.outOfSampleRmse)).toEqual(b.map((f) => f.outOfSampleRmse));
  });

  it("penalises a wildly wrong fixed baseline more than the calibrated arm", () => {
    const rows = calibrateFoldStructures(series, folds, "contagion", opts);
    const calibrated = summariseFoldFits(
      "calib", evaluateFoldFit(series, folds, (i) => rows[i]!.structure, opts),
    );
    const absurd = makeCorrelationStructure({ kind: "global", rho: 0.99, groups: GROUPS });
    const fixed = summariseFoldFits("fixed", evaluateFoldFit(series, folds, () => absurd, opts));
    expect(calibrated.meanOutOfSample).toBeLessThan(fixed.meanOutOfSample);
    expect(fixed.meanBias).toBeGreaterThan(0);
    expect(fixed.overCoupledFolds).toBe(fixed.folds);
  });

  it("reports a positive bias for an over-coupled arm and negative for an under-coupled one", () => {
    const under = makeCorrelationStructure({ kind: "independent", groups: GROUPS });
    const fits = summariseFoldFits("independent", evaluateFoldFit(series, folds, () => under, opts));
    expect(fits.meanBias).toBeLessThan(0);
    expect(fits.overCoupledFolds).toBe(0);
  });
});

describe("compareFoldFits", () => {
  const bars = 1100;
  const { series, volZ } = makeTape(bars, 11, (t) => (t > 600 ? 1.6 : 0.3));
  const folds = foldsOver(bars, 300, 100);
  const opts = { ...OPTS, volZ };

  it("pairs folds and reports a win rate against the baseline", () => {
    const rows = calibrateFoldStructures(series, folds, "blocks", opts);
    const arm = evaluateFoldFit(series, folds, (i) => rows[i]!.structure, opts);
    const baseline = evaluateFoldFit(
      series, folds,
      () => makeCorrelationStructure({ kind: "global", rho: 0.95, groups: GROUPS }),
      opts,
    );
    const cmp = compareFoldFits("calib-blocks", arm, "fixed-global", baseline);
    expect(cmp.folds).toBe(folds.length);
    expect(cmp.meanDiff).toBeLessThan(0);
    expect(cmp.winRate).toBeGreaterThan(0.5);
    expect(cmp.relImprovement).toBeGreaterThan(0);
  });

  it("is exactly neutral when an arm is compared with itself", () => {
    const fixed = makeCorrelationStructure({ kind: "blocks", withinRho: 0.4, acrossRho: 0.2, groups: GROUPS });
    const fits = evaluateFoldFit(series, folds, () => fixed, opts);
    const cmp = compareFoldFits("a", fits, "b", fits);
    expect(cmp.meanDiff).toBeCloseTo(0, 12);
    expect(cmp.winRate).toBe(0);
    expect(cmp.relImprovement).toBeCloseTo(0, 12);
  });

  it("renders both tables", () => {
    const fixed = makeCorrelationStructure({ kind: "global", rho: 0.5, groups: GROUPS });
    const fits = evaluateFoldFit(series, folds, () => fixed, opts);
    const summary = formatFitSummaries([summariseFoldFits("fixed-global", fits)]);
    expect(summary).toContain("OOS rmse");
    expect(summary).toContain("fixed-global");
    const cmp = formatFitComparisons([compareFoldFits("x", fits, "fixed-global", fits)]);
    expect(cmp).toContain("win rate");
  });
});
