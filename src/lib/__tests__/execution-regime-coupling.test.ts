// Locks the regime-dependent coupling: correlation must actually migrate with
// the tape under "ramp", stay a hard switch under "binary", and the per-bar
// regime path must record what was in force so tail sensitivity is auditable.
import { describe, expect, it } from "vitest";
import {
  makeCorrelationStructure,
  clusterMap,
  impliedCorrelation,
  regimeRamp,
  regimeRhos,
  factorWeights,
} from "@/lib/execution-correlation-structures";
import { makeCorrelatedExecutionSampler } from "@/lib/execution-correlated-shocks";

const SYMS = ["AAPL", "MSFT", "ISF.L"];
const structure = makeCorrelationStructure({
  kind: "contagion",
  withinRho: 0.4,
  acrossRho: 0.1,
  stressWithinRho: 0.9,
  stressAcrossRho: 0.8,
  groups: clusterMap(SYMS),
});

describe("regime blending", () => {
  it("ramps 0 → 1 between the two z thresholds", () => {
    expect(regimeRamp(0, 0.5, 2)).toBe(0);
    expect(regimeRamp(1.25, 0.5, 2)).toBeCloseTo(0.5, 10);
    expect(regimeRamp(9, 0.5, 2)).toBe(1);
    expect(regimeRamp(Number.NaN, 0.5, 2)).toBe(0);
  });

  it("interpolates the coupling parameters monotonically", () => {
    const calm = regimeRhos(structure, 0);
    const half = regimeRhos(structure, 0.5);
    const hot = regimeRhos(structure, 1);
    expect(calm.withinRho).toBeCloseTo(0.4, 10);
    expect(hot.withinRho).toBeCloseTo(0.9, 10);
    expect(half.withinRho).toBeGreaterThan(calm.withinRho);
    expect(half.withinRho).toBeLessThan(hot.withinRho);
    expect(half.acrossRho).toBeLessThanOrEqual(half.withinRho);
    expect(impliedCorrelation(structure, "AAPL", "ISF.L", 0.5)).toBeCloseTo(half.acrossRho, 10);
  });

  it("keeps factor loadings unit-norm at every blend", () => {
    for (const t of [0, 0.13, 0.5, 0.87, 1]) {
      const w = factorWeights(structure, "AAPL", t);
      expect(w.market ** 2 + w.cluster ** 2 + w.idio ** 2).toBeCloseTo(1, 10);
    }
  });

  it("booleans remain the exact endpoints", () => {
    expect(regimeRhos(structure, false)).toEqual(regimeRhos(structure, 0));
    expect(regimeRhos(structure, true)).toEqual(regimeRhos(structure, 1));
  });
});

describe("sampler regime path", () => {
  const cfg = {
    structure,
    stressEnterProb: 0,
    stressExitProb: 1,
    volStressZ: 3,
    regimeRampLoZ: 0.5,
    regimeRampHiZ: 2,
  } as const;

  it("shifts coupling with volatility when ramping", () => {
    const s = makeCorrelatedExecutionSampler({ ...cfg, regimeBlend: "ramp" }, 5);
    const zs = [0, 0.5, 1.25, 2, 4];
    for (const z of zs) s.beginBar(z);
    const path = s.regimePath();
    expect(path.map((b) => b.stressT)).toEqual([0, 0, 0.5, 1, 1]);
    expect(path[0]!.withinRho).toBeCloseTo(0.4, 10);
    expect(path[4]!.withinRho).toBeCloseTo(0.9, 10);
    // Strictly rising coupling as the tape heats up.
    for (let i = 1; i < path.length; i++) {
      expect(path[i]!.withinRho).toBeGreaterThanOrEqual(path[i - 1]!.withinRho);
    }
  });

  it("stays a hard switch in binary mode", () => {
    const s = makeCorrelatedExecutionSampler({ ...cfg, regimeBlend: "binary" }, 5);
    for (const z of [0, 1.25, 4]) s.beginBar(z);
    expect(s.regimePath().map((b) => b.stressT)).toEqual([0, 0, 1]);
  });

  it("floors the blend once the Markov chain declares stress", () => {
    const s = makeCorrelatedExecutionSampler(
      { ...cfg, regimeBlend: "ramp", stressEnterProb: 1, stressExitProb: 0, stressBlendFloor: 0.75 },
      5,
    );
    const bar = s.beginBar(0);
    expect(bar.stressed).toBe(true);
    expect(bar.stressT).toBeCloseTo(0.75, 10);
  });

  it("does not change draws when ramping is off", () => {
    const run = (blend: "binary" | "ramp") => {
      const s = makeCorrelatedExecutionSampler({ ...cfg, regimeBlend: blend, regimeRampLoZ: 99, regimeRampHiZ: 100 }, 9);
      const out: number[] = [];
      for (let i = 0; i < 30; i++) {
        s.beginBar(0);
        for (const sym of SYMS) out.push(s.draw(sym).slippageMult);
      }
      return out;
    };
    expect(run("ramp")).toEqual(run("binary"));
  });
});
