import { describe, expect, it } from "vitest";
import {
  clusterSpilloverMatrix,
  clusterTailContributions,
  formatSpilloverHeatmap,
  formatTailContributions,
  topSpilloverPairs,
} from "../execution-cluster-spillover";
import {
  makeCorrelatedExecutionSampler,
  DEFAULT_CORRELATED_EXECUTION,
} from "../execution-correlated-shocks";
import { makeCorrelationStructure } from "../execution-correlation-structures";

/** Deterministic normal-ish generator so the fixtures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const normal = (r: () => number) => {
  const u = Math.max(1e-9, r());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
};

/**
 * Two clusters of two symbols. Within-cluster names share a strong cluster
 * factor; cross-cluster coupling comes only from a weak market factor, and it
 * strengthens in the second half of the tape (the "stressed" stretch).
 */
function twoClusterTape(bars = 600) {
  const r = rng(11);
  const syms = ["A1", "A2", "B1", "B2"];
  const groups = new Map([["A1", "alpha"], ["A2", "alpha"], ["B1", "beta"], ["B2", "beta"]]);
  const prices = new Map(syms.map((s) => [s, [100]]));
  const volZ: number[] = [0];
  for (let i = 1; i < bars; i++) {
    const stressed = i > bars / 2;
    const market = normal(r) * (stressed ? 1 : 1);
    const za = normal(r);
    const zb = normal(r);
    const mktW = stressed ? 0.75 : 0.15;
    const scale = stressed ? 0.03 : 0.01;
    for (const s of syms) {
      const cluster = s.startsWith("A") ? za : zb;
      const z = mktW * market + Math.sqrt(Math.max(0, 1 - mktW ** 2)) * (0.9 * cluster + 0.44 * normal(r));
      const prev = prices.get(s)!;
      prev.push(Math.max(1, prev[prev.length - 1]! * (1 + z * scale)));
    }
    volZ.push(stressed ? 2.5 : 0);
  }
  return { series: prices as ReadonlyMap<string, number[]>, groups, volZ };
}

describe("clusterSpilloverMatrix", () => {
  const { series, groups, volZ } = twoClusterTape();
  const m = clusterSpilloverMatrix(series, { groups, volZ, window: 60, step: 10, stressZ: 1.5 });

  it("produces a symmetric cluster × cluster matrix", () => {
    expect(m.clusters).toEqual(["alpha", "beta"]);
    expect(m.cells[0]![1]!.calm).toBeCloseTo(m.cells[1]![0]!.calm, 10);
    expect(m.cells[0]![1]!.stress).toBeCloseTo(m.cells[1]![0]!.stress, 10);
  });

  it("separates calm and stressed windows", () => {
    expect(m.windows).toBeGreaterThan(5);
    expect(m.stressWindows).toBeGreaterThan(0);
    expect(m.stressWindows).toBeLessThan(m.windows);
  });

  it("recovers stronger intra-cluster than cross-cluster coupling in calm windows", () => {
    const within = (m.cells[0]![0]!.calm + m.cells[1]![1]!.calm) / 2;
    expect(within).toBeGreaterThan(m.cells[0]![1]!.calm);
  });

  it("detects cross-cluster contagion as a positive stress uplift", () => {
    expect(m.cells[0]![1]!.delta).toBeGreaterThan(0);
    const top = topSpilloverPairs(m, 4);
    expect(top.length).toBeGreaterThan(0);
    expect(top[0]!.delta).toBeGreaterThanOrEqual(top[top.length - 1]!.delta);
  });

  it("renders a heatmap with a row per cluster", () => {
    const text = formatSpilloverHeatmap(m, "stress");
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text.split("\n").length).toBe(m.clusters.length + 2);
  });

  it("returns an empty result rather than throwing on a degenerate tape", () => {
    const empty = clusterSpilloverMatrix(new Map([["A", [1, 2, 3]]]));
    expect(empty.cells.flat().every((c) => Number.isNaN(c.calm))).toBe(true);
    expect(formatSpilloverHeatmap(empty)).toBeTypeOf("string");
  });
});

describe("clusterTailContributions", () => {
  it("splits damage shares over positive contributors only", () => {
    const rows = clusterTailContributions(-20, [
      { cluster: "tech", metric: -12, symbols: 5 },
      { cluster: "gold", metric: -18, symbols: 2 },
      { cluster: "bond", metric: -21, symbols: 1 },
    ], "lowerIsWorse");
    expect(rows[0]!.cluster).toBe("tech");
    expect(rows[0]!.damage).toBeCloseTo(8);
    expect(rows.find((r) => r.cluster === "bond")!.share).toBe(0);
    const total = rows.reduce((s, r) => s + r.share, 0);
    expect(total).toBeCloseTo(1);
  });

  it("flips orientation for cost-like metrics", () => {
    const rows = clusterTailContributions(100, [
      { cluster: "tech", metric: 80 },
      { cluster: "gold", metric: 98 },
    ], "higherIsWorse");
    expect(rows[0]!.cluster).toBe("tech");
    expect(rows[0]!.damage).toBeCloseTo(20);
  });

  it("degrades gracefully when no cluster is harmful", () => {
    const rows = clusterTailContributions(-10, [{ cluster: "a", metric: -12 }]);
    expect(rows[0]!.share).toBe(0);
    expect(formatTailContributions(rows, { baseline: -10 })).toContain("a");
  });
});

describe("decoupled symbols in the shock sampler", () => {
  const structure = makeCorrelationStructure({
    kind: "contagion",
    withinRho: 0.6,
    acrossRho: 0.2,
    stressWithinRho: 0.9,
    stressAcrossRho: 0.8,
    groups: new Map([["A1", "alpha"], ["A2", "alpha"], ["B1", "beta"]]),
  });
  const cfg = { ...DEFAULT_CORRELATED_EXECUTION, structure, stressEnterProb: 1, stressExitProb: 0 };

  it("keeps the random stream aligned with the base run", () => {
    const base = makeCorrelatedExecutionSampler(cfg, 42);
    const abl = makeCorrelatedExecutionSampler({ ...cfg, decoupledSymbols: new Set(["A1"]) }, 42);
    for (let i = 0; i < 50; i++) {
      base.beginBar(0);
      abl.beginBar(0);
      base.draw("A1");
      abl.draw("A1");
      // Symbols outside the decoupled set must be bit-identical.
      expect(abl.draw("B1")).toEqual(base.draw("B1"));
      expect(abl.regime().stressed).toBe(base.regime().stressed);
    }
  });

  it("removes the stress amplification for the decoupled symbol", () => {
    const base = makeCorrelatedExecutionSampler(cfg, 7);
    const abl = makeCorrelatedExecutionSampler({ ...cfg, decoupledSymbols: new Set(["A1"]) }, 7);
    let baseSlip = 0;
    let ablSlip = 0;
    for (let i = 0; i < 400; i++) {
      base.beginBar(3);
      abl.beginBar(3);
      baseSlip += base.draw("A1").slippageMult;
      ablSlip += abl.draw("A1").slippageMult;
    }
    expect(ablSlip).toBeLessThan(baseSlip);
  });
});
