import { describe, expect, it } from "vitest";
import {
  clusterMap,
  correlationMatrix,
  defaultCluster,
  factorWeights,
  impliedCorrelation,
  makeCorrelationStructure,
} from "../execution-correlation-structures";
import { makeCorrelatedExecutionSampler } from "../execution-correlated-shocks";

const SYMS = ["AAPL", "MSFT", "ISF.L", "VUKE.L", "SGLN.L", "XUKS.L"];

/** Pearson correlation of two equal-length samples. */
function corr(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / Math.sqrt(da * db);
}

/**
 * Empirical cross-symbol correlation of log-slippage from the sampler, with
 * stress disabled so only the correlation structure is under test.
 */
function empiricalCorr(structure: ReturnType<typeof makeCorrelationStructure>, a: string, b: string) {
  const sampler = makeCorrelatedExecutionSampler(
    {
      structure,
      slippageSigma: 0.5,
      tailProb: 0,
      stressEnterProb: 0,
      stressExitProb: 1,
      volStressZ: Infinity,
      noFillProb: 0,
      fullFillProb: 1,
      maxSlippageMult: 1e9,
    },
    12345,
  );
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < 6000; i++) {
    sampler.beginBar(0);
    xs.push(Math.log(sampler.draw(a).slippageMult));
    ys.push(Math.log(sampler.draw(b).slippageMult));
  }
  return corr(xs, ys);
}

describe("correlation structures", () => {
  it("implies the specified within/across correlations", () => {
    const s = makeCorrelationStructure({
      kind: "blocks",
      withinRho: 0.8,
      acrossRho: 0.2,
      groups: clusterMap(SYMS),
    });
    expect(impliedCorrelation(s, "AAPL", "MSFT")).toBeCloseTo(0.8, 10);
    expect(impliedCorrelation(s, "AAPL", "ISF.L")).toBeCloseTo(0.2, 10);
    expect(impliedCorrelation(s, "AAPL", "AAPL")).toBe(1);
  });

  it("global structure is the single-factor special case", () => {
    const s = makeCorrelationStructure({ kind: "global", rho: 0.45 });
    expect(impliedCorrelation(s, "AAPL", "ISF.L")).toBeCloseTo(0.45, 10);
    const w = factorWeights(s, "AAPL");
    expect(w.cluster).toBeCloseTo(0, 10);
    expect(w.market ** 2 + w.idio ** 2).toBeCloseTo(1, 10);
  });

  it("independent structure decouples everything", () => {
    const s = makeCorrelationStructure({ kind: "independent", rho: 0.9 });
    expect(impliedCorrelation(s, "AAPL", "MSFT")).toBe(0);
    expect(empiricalCorr(s, "AAPL", "MSFT")).toBeCloseTo(0, 1);
  });

  it("factor loadings are unit-norm for every structure", () => {
    for (const kind of ["independent", "global", "blocks", "contagion"] as const) {
      const s = makeCorrelationStructure({ kind, rho: 0.5, groups: clusterMap(SYMS) });
      for (const sym of SYMS) {
        for (const stressed of [false, true]) {
          const w = factorWeights(s, sym, stressed);
          expect(w.market ** 2 + w.cluster ** 2 + w.idio ** 2).toBeCloseTo(1, 10);
        }
      }
    }
  });

  it("contagion raises correlation in stress but not in calm", () => {
    const s = makeCorrelationStructure({
      kind: "contagion",
      withinRho: 0.6,
      acrossRho: 0.1,
      groups: clusterMap(SYMS),
    });
    expect(impliedCorrelation(s, "AAPL", "ISF.L", true))
      .toBeGreaterThan(impliedCorrelation(s, "AAPL", "ISF.L", false));
    expect(impliedCorrelation(s, "AAPL", "MSFT", true))
      .toBeGreaterThan(impliedCorrelation(s, "AAPL", "MSFT", false));
  });

  it("keeps across-cluster correlation below within-cluster", () => {
    const s = makeCorrelationStructure({
      kind: "blocks",
      withinRho: 0.3,
      acrossRho: 0.9, // nonsensical: must be clamped down to within
      groups: clusterMap(SYMS),
    });
    expect(s.acrossRho).toBeLessThanOrEqual(s.withinRho);
  });

  it("produces a symmetric matrix with a unit diagonal", () => {
    const s = makeCorrelationStructure({ kind: "blocks", groups: clusterMap(SYMS) });
    const m = correlationMatrix(s, SYMS);
    for (let i = 0; i < SYMS.length; i++) {
      expect(m[i]![i]).toBe(1);
      for (let j = 0; j < SYMS.length; j++) expect(m[i]![j]).toBeCloseTo(m[j]![i]!, 12);
    }
  });

  it("clusters LSE, US tech, metals and inverse ETFs apart", () => {
    expect(defaultCluster("ISF.L")).toBe("uk-equity");
    expect(defaultCluster("AAPL")).toBe("us-tech");
    expect(defaultCluster("SGLN.L")).toBe("metals");
    expect(defaultCluster("XUKS.L")).toBe("inverse");
    expect(defaultCluster("AAPL")).not.toBe(defaultCluster("ISF.L"));
  });
});

describe("sampler honours the structure", () => {
  it("realises the block correlations it promises", () => {
    const s = makeCorrelationStructure({
      kind: "blocks",
      withinRho: 0.8,
      acrossRho: 0.15,
      groups: clusterMap(SYMS),
    });
    // Same cluster: strongly coupled. Different cluster: weakly coupled.
    expect(empiricalCorr(s, "AAPL", "MSFT")).toBeCloseTo(0.8, 1);
    expect(empiricalCorr(s, "AAPL", "ISF.L")).toBeCloseTo(0.15, 1);
  });

  it("reproduces the legacy global-rho behaviour when no structure is given", () => {
    const cfg = { slippageSigma: 0.4, rho: 0.6, volStressZ: Infinity } as const;
    const a = makeCorrelatedExecutionSampler(cfg, 99);
    const b = makeCorrelatedExecutionSampler(
      { ...cfg, structure: makeCorrelationStructure({ kind: "global", rho: 0.6 }) },
      99,
    );
    for (let i = 0; i < 50; i++) {
      a.beginBar(0);
      b.beginBar(0);
      expect(a.draw("AAPL")).toEqual(b.draw("AAPL"));
    }
  });

  it("is deterministic for a given seed and structure", () => {
    const s = makeCorrelationStructure({ kind: "contagion", groups: clusterMap(SYMS) });
    const run = () => {
      const smp = makeCorrelatedExecutionSampler({ structure: s }, 7);
      const out: number[] = [];
      for (let i = 0; i < 40; i++) {
        smp.beginBar(i % 9 === 0 ? 3 : 0);
        for (const sym of SYMS) out.push(smp.draw(sym).slippageMult);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});
