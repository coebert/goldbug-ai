import { describe, it, expect } from "vitest";
import {
  CALIBRATION_SNAPSHOT_VERSION,
  buildCalibrationSnapshot,
  describeSnapshot,
  describeTapeCheck,
  foldStructuresFromSnapshot,
  optionsFromSnapshot,
  parseCalibrationSnapshot,
  pooledFromSnapshot,
  serialiseCalibrationSnapshot,
  structureFromSnapshot,
  tapeFingerprint,
  tapeIdentity,
  verifySnapshotAgainstTape,
  windowsFromSnapshot,
} from "../execution-correlation-snapshot";
import {
  calibrateCorrelations,
  structureFromCalibration,
} from "../execution-correlation-calibration";
import { calibrateFoldStructures } from "../execution-oos-calibration";
import {
  makeCorrelatedExecutionSampler,
  DEFAULT_CORRELATED_EXECUTION,
} from "../execution-correlated-shocks";

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

function makeTape(bars: number, seed: number) {
  const r = rng(seed);
  const series = new Map<string, number[]>(SYMBOLS.map((s) => [s, [100]]));
  const volZ = [0];
  for (let t = 1; t < bars; t++) {
    const stressed = t > bars * 0.7;
    volZ.push(stressed ? 2.5 : 0);
    const market = gauss(r);
    const alpha = gauss(r);
    const beta = gauss(r);
    const w = stressed ? 1.6 : 0.3;
    for (const s of SYMBOLS) {
      const cl = s.startsWith("A") ? alpha : beta;
      const arr = series.get(s)!;
      arr.push(Math.max(1, arr[arr.length - 1]! * (1 + (w * market + 0.9 * cl + 0.6 * gauss(r)) * 0.004)));
    }
  }
  return { series: series as ReadonlyMap<string, readonly number[]>, volZ };
}

const OPTS = { groups: GROUPS, window: 40, step: 5, stressZ: 1.5, minStressShare: 0.25 } as const;

function fixture(bars = 600, seed = 7) {
  const { series, volZ } = makeTape(bars, seed);
  const cal = calibrateCorrelations(series, { ...OPTS, volZ });
  const structure = structureFromCalibration(cal, "contagion", GROUPS);
  const snap = buildCalibrationSnapshot({
    calibration: cal,
    structure,
    tape: tapeIdentity(series, { from: "2020-01-01", to: "2022-01-01", priceMode: "total_return" }),
    stressZ: OPTS.stressZ,
    minStressShare: OPTS.minStressShare,
    label: "unit-test",
    createdAt: "2026-08-11T00:00:00.000Z",
  });
  return { series, volZ, cal, structure, snap };
}

describe("tapeFingerprint", () => {
  it("is stable across Map insertion order and repeated calls", () => {
    const { series } = makeTape(80, 1);
    const reversed = new Map([...series.entries()].reverse());
    expect(tapeFingerprint(reversed)).toBe(tapeFingerprint(series));
    expect(tapeFingerprint(series)).toBe(tapeFingerprint(series));
  });

  it("changes when a price, a bar, or a symbol changes", () => {
    const { series } = makeTape(80, 1);
    const base = tapeFingerprint(series);

    const nudged = new Map([...series.entries()].map(([s, v]) => [s, [...v]]));
    nudged.get("A1")![10] = nudged.get("A1")![10]! * 1.01;
    expect(tapeFingerprint(nudged)).not.toBe(base);

    const extraBar = new Map([...series.entries()].map(([s, v]) => [s, [...v, 100]]));
    expect(tapeFingerprint(extraBar)).not.toBe(base);

    const dropped = new Map([...series.entries()].filter(([s]) => s !== "B3"));
    expect(tapeFingerprint(dropped)).not.toBe(base);
  });

  it("survives a JSON round-trip of the prices", () => {
    const { series } = makeTape(60, 4);
    const round = new Map<string, number[]>(
      JSON.parse(JSON.stringify([...series.entries()])) as [string, number[]][],
    );
    expect(tapeFingerprint(round)).toBe(tapeFingerprint(series));
  });
});

describe("snapshot round-trip", () => {
  it("preserves the pooled estimates, options and structure exactly", () => {
    const { cal, structure, snap } = fixture();
    const back = parseCalibrationSnapshot(serialiseCalibrationSnapshot(snap));

    expect(back.version).toBe(CALIBRATION_SNAPSHOT_VERSION);
    expect(back.label).toBe("unit-test");
    expect(optionsFromSnapshot(back)).toMatchObject({
      window: cal.window,
      step: cal.step,
      basis: cal.basis,
      shrink: cal.shrink,
      stressZ: OPTS.stressZ,
      minStressShare: OPTS.minStressShare,
    });

    const pooled = pooledFromSnapshot(back);
    expect(pooled.calm.within.rho).toBeCloseTo(cal.calm.within.rho, 12);
    expect(pooled.stress.across.rho).toBeCloseTo(cal.stress.across.rho, 12);
    expect(pooled.calm.across.windows).toBe(cal.calm.across.windows);

    const rebuilt = structureFromSnapshot(back);
    expect(rebuilt.kind).toBe(structure.kind);
    expect(rebuilt.withinRho).toBeCloseTo(structure.withinRho, 12);
    expect(rebuilt.acrossRho).toBeCloseTo(structure.acrossRho, 12);
    expect(rebuilt.stressWithinRho).toBeCloseTo(structure.stressWithinRho, 12);
    expect(rebuilt.stressAcrossRho).toBeCloseTo(structure.stressAcrossRho, 12);
    expect([...rebuilt.groups.entries()].sort()).toEqual([...structure.groups.entries()].sort());
  });

  it("keeps the rolling-window series verbatim", () => {
    const { cal, snap } = fixture();
    const back = parseCalibrationSnapshot(serialiseCalibrationSnapshot(snap));
    const windows = windowsFromSnapshot(back);
    expect(windows).toHaveLength(cal.windows.length);
    expect(windows[0]).toEqual(cal.windows[0]);
    expect(windows.at(-1)).toEqual(cal.windows.at(-1));
  });

  it("drops the windows with includeWindows: false but keeps the parameters", () => {
    const { cal, structure, series } = fixture();
    const slim = buildCalibrationSnapshot({
      calibration: cal,
      structure,
      tape: tapeIdentity(series),
      stressZ: 1.5,
      minStressShare: 0.25,
      includeWindows: false,
    });
    expect(slim.windows).toBeUndefined();
    expect(serialiseCalibrationSnapshot(slim).length)
      .toBeLessThan(serialiseCalibrationSnapshot(fixture().snap).length);
    expect(structureFromSnapshot(slim).withinRho).toBeCloseTo(structure.withinRho, 12);
  });

  it("survives a NaN pooled estimate (a regime with no windows)", () => {
    const { series, volZ } = makeTape(300, 3);
    // stressZ far out of reach → the stress bucket is empty and pools to NaN.
    const cal = calibrateCorrelations(series, { ...OPTS, volZ, stressZ: 99 });
    expect(Number.isNaN(cal.stress.within.rho)).toBe(true);
    const snap = buildCalibrationSnapshot({
      calibration: cal,
      structure: structureFromCalibration(cal, "contagion", GROUPS),
      tape: tapeIdentity(series),
      stressZ: 99,
      minStressShare: 0.25,
    });
    const back = parseCalibrationSnapshot(serialiseCalibrationSnapshot(snap));
    expect(Number.isNaN(pooledFromSnapshot(back).stress.within.rho)).toBe(true);
    expect(pooledFromSnapshot(back).stress.within.windows).toBe(0);
  });

  it("rejects an unknown version and a malformed body", () => {
    const { snap } = fixture();
    expect(() => parseCalibrationSnapshot({ ...snap, version: 99 })).toThrow(/version/i);
    expect(() => parseCalibrationSnapshot({ ...snap, pooled: undefined })).toThrow();
    expect(() => parseCalibrationSnapshot("{not json")).toThrow();
  });
});

describe("reproducibility", () => {
  it("a reloaded structure drives the sampler to bit-identical draws", () => {
    const { structure, snap } = fixture();
    const reloaded = structureFromSnapshot(
      parseCalibrationSnapshot(serialiseCalibrationSnapshot(snap)),
    );
    const draw = (s: typeof structure) => {
      const sampler = makeCorrelatedExecutionSampler(
        { ...DEFAULT_CORRELATED_EXECUTION, structure: s }, 4242,
      );
      const out: number[] = [];
      for (let bar = 0; bar < 40; bar++) {
        sampler.beginBar(bar > 25 ? 2.5 : 0);
        for (const sym of SYMBOLS) {
          const d = sampler.draw(sym);
          out.push(d.slippageMult, d.fillRatio);
        }
      }
      return out;
    };
    expect(draw(reloaded)).toEqual(draw(structure));
  });

  it("re-fitting the same tape with the saved options reproduces the saved numbers", () => {
    const { series, volZ, snap } = fixture();
    const refit = calibrateCorrelations(series, {
      ...optionsFromSnapshot(snap, GROUPS),
      volZ,
    });
    expect(refit.calm.within.rho).toBeCloseTo(pooledFromSnapshot(snap).calm.within.rho, 12);
    expect(refit.windows.length).toBe(windowsFromSnapshot(snap).length);
  });
});

describe("per-fold structures", () => {
  const { series, volZ } = makeTape(700, 21);
  const folds = [
    { trainStart: 0, trainEnd: 299, testStart: 300, testEnd: 399 },
    { trainStart: 100, trainEnd: 399, testStart: 400, testEnd: 499 },
    { trainStart: 200, trainEnd: 499, testStart: 500, testEnd: 599 },
  ];

  it("round-trips every fold's fitted structure", () => {
    const rows = calibrateFoldStructures(series, folds, "contagion", { ...OPTS, volZ });
    const cal = calibrateCorrelations(series, { ...OPTS, volZ });
    const snap = parseCalibrationSnapshot(serialiseCalibrationSnapshot(buildCalibrationSnapshot({
      calibration: cal,
      structure: structureFromCalibration(cal, "contagion", GROUPS),
      tape: tapeIdentity(series),
      stressZ: OPTS.stressZ,
      minStressShare: OPTS.minStressShare,
      folds: rows.map((calibration, i) => ({ calibration, window: folds[i]! })),
    })));

    expect(snap.folds).toHaveLength(folds.length);
    expect(snap.folds![1]).toMatchObject({ fold: 1, kind: "contagion", trainStart: 100, testEnd: 499 });
    const rebuilt = foldStructuresFromSnapshot(snap, GROUPS);
    expect(rebuilt.size).toBe(rows.length);
    for (const [i, row] of rows.entries()) {
      expect(rebuilt.get(i)!.withinRho).toBeCloseTo(row.structure.withinRho, 12);
      expect(rebuilt.get(i)!.stressWithinRho).toBeCloseTo(row.structure.stressWithinRho, 12);
    }
    expect(describeSnapshot(snap)).toContain("per-fold");
  });
});

describe("verifySnapshotAgainstTape", () => {
  const { series, snap } = fixture();
  const meta = { from: "2020-01-01", to: "2022-01-01", priceMode: "total_return" };

  it("accepts the tape it was fitted on", () => {
    const check = verifySnapshotAgainstTape(snap, series, meta);
    expect(check.matches).toBe(true);
    expect(check.reasons).toEqual([]);
    expect(describeTapeCheck(check)).toContain("reproduction");
  });

  it("flags a changed price with the same shape", () => {
    const tweaked = new Map([...series.entries()].map(([s, v]) => [s, [...v]]));
    tweaked.get("A2")![50] = tweaked.get("A2")![50]! * 1.05;
    const check = verifySnapshotAgainstTape(snap, tweaked, meta);
    expect(check.matches).toBe(false);
    expect(check.fingerprintMatches).toBe(false);
    expect(check.reasons.join(" ")).toMatch(/prices differ/);
  });

  it("names missing and extra symbols and a bar-count change", () => {
    const changed = new Map(
      [...series.entries()].filter(([s]) => s !== "B3").map(([s, v]) => [s, v.slice(0, -5)]),
    );
    changed.set("C9", new Array(changed.get("A1")!.length).fill(100));
    const check = verifySnapshotAgainstTape(snap, changed, meta);
    expect(check.missingSymbols).toEqual(["B3"]);
    expect(check.extraSymbols).toEqual(["C9"]);
    expect(check.tapeBars).toBe(check.snapshotBars - 5);
    expect(check.reasons.join(" ")).toMatch(/bar count/);
    expect(describeTapeCheck(check)).toContain("not a reproduction");
  });

  it("flags a different date range even when the bars line up", () => {
    const check = verifySnapshotAgainstTape(snap, series, { ...meta, to: "2023-01-01" });
    expect(check.fingerprintMatches).toBe(true);
    expect(check.matches).toBe(false);
    expect(check.reasons.join(" ")).toMatch(/to 2023-01-01/);
  });
});
