// Locks the historical calibration: it must recover a coupling it is shown,
// separate calm from stressed windows, and degrade honestly on thin data.
import { describe, expect, it } from "vitest";
import {
  calibrateCorrelations,
  describeCalibration,
  fisherMean,
  returnSeries,
  rollingCorrelationWindows,
  structureFromCalibration,
} from "@/lib/execution-correlation-calibration";
import { impliedCorrelation } from "@/lib/execution-correlation-structures";
import { marketVolZScores } from "@/lib/execution-correlated-shocks";

/** Deterministic normal draws. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    const u = (a >>> 8) / 16777216 || 1e-9;
    a = (a * 1664525 + 1013904223) >>> 0;
    const v = (a >>> 8) / 16777216;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

const GROUPS = new Map([
  ["A1", "g1"], ["A2", "g1"], ["A3", "g1"],
  ["B1", "g2"], ["B2", "g2"], ["B3", "g2"],
]);

/**
 * Builds price series whose *returns* have a known block correlation:
 * r = sqrt(across)*M + sqrt(within-across)*G + sqrt(1-within)*E, optionally
 * with a high-correlation, high-volatility stretch at the end.
 */
function syntheticTape(opts: {
  bars: number;
  within: number;
  across: number;
  stressBars?: number;
  stressWithin?: number;
  stressAcross?: number;
  stressVolMult?: number;
  seed?: number;
}) {
  const rng = makeRng(opts.seed ?? 7);
  const syms = [...GROUPS.keys()];
  const prices = new Map(syms.map((s) => [s, [100]]));
  const total = opts.bars + (opts.stressBars ?? 0);
  for (let t = 0; t < total; t++) {
    const stressed = t >= opts.bars;
    const within = stressed ? (opts.stressWithin ?? opts.within) : opts.within;
    const across = Math.min(within, stressed ? (opts.stressAcross ?? opts.across) : opts.across);
    const vol = 0.01 * (stressed ? (opts.stressVolMult ?? 4) : 1);
    const m = rng();
    const g = new Map([...new Set(GROUPS.values())].map((k) => [k, rng()]));
    for (const s of syms) {
      const z = Math.sqrt(across) * m
        + Math.sqrt(Math.max(0, within - across)) * g.get(GROUPS.get(s)!)!
        + Math.sqrt(Math.max(0, 1 - within)) * rng();
      const arr = prices.get(s)!;
      arr.push(arr[arr.length - 1]! * Math.exp(z * vol));
    }
  }
  return prices as ReadonlyMap<string, number[]>;
}

describe("fisherMean", () => {
  it("pools correlations without the naive-average bias", () => {
    expect(fisherMean([0.5, 0.5, 0.5])).toBeCloseTo(0.5, 10);
    expect(fisherMean([0.2, 0.9])).toBeGreaterThan(0.55);
    expect(fisherMean([])).toBeNaN();
    expect(fisherMean([Number.NaN, 0.4])).toBeCloseTo(0.4, 10);
  });
});

describe("returnSeries", () => {
  it("takes log returns, and absolute values on the vol basis", () => {
    const src = new Map([["A", [100, 110, 99]]]);
    expect(returnSeries(src, "returns").get("A")![0]).toBeCloseTo(Math.log(1.1), 12);
    const abs = returnSeries(src, "absReturns").get("A")!;
    expect(abs.every((v) => v >= 0)).toBe(true);
    expect(abs.length).toBe(2);
  });

  it("skips series too short to difference", () => {
    expect(returnSeries(new Map([["A", [100]]])).size).toBe(0);
  });
});

describe("rolling calibration", () => {
  it("recovers a known block structure from returns", () => {
    const tape = syntheticTape({ bars: 1500, within: 0.7, across: 0.2 });
    const cal = calibrateCorrelations(tape, {
      groups: GROUPS,
      basis: "returns",
      window: 120,
      step: 20,
    });
    expect(cal.calm.within.rho).toBeCloseTo(0.7, 1);
    expect(cal.calm.across.rho).toBeCloseTo(0.2, 1);
    expect(cal.calm.within.windows).toBeGreaterThan(20);
  });

  it("separates stressed windows and finds higher coupling in them", () => {
    const tape = syntheticTape({
      bars: 1200,
      within: 0.4,
      across: 0.1,
      stressBars: 500,
      stressWithin: 0.9,
      stressAcross: 0.8,
      stressVolMult: 6,
    });
    const volZ = marketVolZScores(tape, 20);
    const cal = calibrateCorrelations(tape, {
      groups: GROUPS,
      basis: "returns",
      window: 120,
      step: 20,
      volZ,
      stressZ: 1,
      minStressShare: 0.5,
    });
    expect(cal.stress.within.windows).toBeGreaterThan(3);
    expect(cal.stress.within.rho).toBeGreaterThan(cal.calm.within.rho);
    expect(cal.stress.across.rho).toBeGreaterThan(cal.calm.across.rho);
    expect(cal.stressShare).toBeGreaterThan(0.1);
    expect(cal.stressShare).toBeLessThan(0.9);
  });

  it("emits a rolling series ordered in time with pair counts", () => {
    const tape = syntheticTape({ bars: 600, within: 0.5, across: 0.2 });
    const rows = rollingCorrelationWindows(tape, { groups: GROUPS, window: 100, step: 25 });
    expect(rows.length).toBeGreaterThan(5);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.endIndex).toBeGreaterThan(rows[i - 1]!.endIndex);
    }
    expect(rows[0]!.withinPairs).toBe(6); // 2 clusters × C(3,2)
    expect(rows[0]!.acrossPairs).toBe(9); // 3 × 3
  });

  it("shrinks the estimate toward zero when asked", () => {
    const tape = syntheticTape({ bars: 800, within: 0.8, across: 0.3 });
    const base = calibrateCorrelations(tape, { groups: GROUPS, basis: "returns", window: 120 });
    const shrunk = calibrateCorrelations(tape, { groups: GROUPS, basis: "returns", window: 120, shrink: 0.5 });
    expect(shrunk.calm.within.rho).toBeCloseTo(base.calm.within.rho * 0.5, 10);
  });

  it("returns nothing rather than noise on thin data", () => {
    expect(rollingCorrelationWindows(new Map([["A", [1, 2, 3]]]), { window: 50 })).toEqual([]);
    expect(rollingCorrelationWindows(new Map(), {})).toEqual([]);
  });
});

describe("structureFromCalibration", () => {
  it("builds a contagion structure whose stress coupling exceeds calm", () => {
    const tape = syntheticTape({
      bars: 1000, within: 0.4, across: 0.1,
      stressBars: 400, stressWithin: 0.9, stressAcross: 0.8, stressVolMult: 6,
    });
    const cal = calibrateCorrelations(tape, {
      groups: GROUPS, basis: "returns", window: 120, step: 20,
      volZ: marketVolZScores(tape, 20), stressZ: 1, minStressShare: 0.5,
    });
    const s = structureFromCalibration(cal, "contagion", GROUPS);
    expect(s.kind).toBe("contagion");
    expect(s.acrossRho).toBeLessThanOrEqual(s.withinRho);
    expect(s.stressWithinRho).toBeGreaterThanOrEqual(s.withinRho);
    expect(impliedCorrelation(s, "A1", "B1", true))
      .toBeGreaterThan(impliedCorrelation(s, "A1", "B1", false));
  });

  it("keeps stress equal to calm when the tape had no stress windows", () => {
    const tape = syntheticTape({ bars: 800, within: 0.5, across: 0.2 });
    const cal = calibrateCorrelations(tape, {
      groups: GROUPS, basis: "returns", window: 120, stressZ: 99,
    });
    const s = structureFromCalibration(cal, "contagion", GROUPS);
    expect(s.stressWithinRho).toBeCloseTo(s.withinRho, 10);
    expect(s.stressAcrossRho).toBeCloseTo(s.acrossRho, 10);
  });

  it("falls back to sane defaults on an empty calibration", () => {
    const cal = calibrateCorrelations(new Map(), {});
    const s = structureFromCalibration(cal, "blocks");
    expect(s.withinRho).toBeGreaterThan(0);
    expect(s.acrossRho).toBeLessThanOrEqual(s.withinRho);
    expect(describeCalibration(cal)).toContain("n/a");
  });
});
