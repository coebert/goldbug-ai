import { describe, it, expect } from "vitest";
import {
  correlationMatrix,
  clusterByCorrelation,
  sizeAgainstClusterCap,
} from "@/lib/sizing/correlation-cluster";

describe("correlation-aware sizing", () => {
  it("computes a symmetric matrix with 1s on diagonal", () => {
    const m = correlationMatrix({
      A: [1, 2, 3, 4, 5],
      B: [2, 4, 6, 8, 10],
      C: [5, 4, 3, 2, 1],
    });
    expect(m.A.A).toBe(1);
    expect(m.A.B).toBeCloseTo(1, 6);
    expect(m.A.C).toBeCloseTo(-1, 6);
    expect(m.B.A).toBeCloseTo(m.A.B, 9);
  });

  it("groups highly-correlated symbols into one cluster", () => {
    const m = correlationMatrix({
      A: [1, 2, 3, 4, 5, 6],
      B: [1.1, 2.1, 3.05, 4.2, 5.1, 6.05], // ~perfect with A
      C: [5, 3, 6, 2, 8, 1],                // random-ish vs A
    });
    const groups = clusterByCorrelation(m, 0.9);
    const withA = groups.find((g) => g.includes("A"))!;
    expect(withA).toContain("B");
    expect(withA).not.toContain("C");
  });

  it("clips a proposed weight to the cluster headroom", () => {
    const r = sizeAgainstClusterCap({
      currentWeights: { AAPL: 0.08, MSFT: 0.07 },
      proposedSymbol: "NVDA",
      proposedWeight: 0.06,
      clusters: [["AAPL", "MSFT", "NVDA"]],
      clusterCap: 0.2,
    });
    expect(r.breached_cap).toBe(true);
    expect(r.allowed_weight).toBeCloseTo(0.05, 9); // 0.20 - (0.08 + 0.07)
    expect(r.scale).toBeCloseTo(0.05 / 0.06, 9);
  });

  it("passes through unchanged when inside the cap", () => {
    const r = sizeAgainstClusterCap({
      currentWeights: { AAPL: 0.03 },
      proposedSymbol: "NVDA",
      proposedWeight: 0.05,
      clusters: [["AAPL", "NVDA"]],
      clusterCap: 0.2,
    });
    expect(r.breached_cap).toBe(false);
    expect(r.allowed_weight).toBe(0.05);
    expect(r.scale).toBe(1);
  });

  it("treats a lone symbol as its own cluster", () => {
    const r = sizeAgainstClusterCap({
      currentWeights: {},
      proposedSymbol: "GLD",
      proposedWeight: 0.04,
      clusters: [["AAPL", "MSFT"]],
      clusterCap: 0.2,
    });
    expect(r.cluster).toEqual(["GLD"]);
    expect(r.allowed_weight).toBe(0.04);
  });

  it("blocks entirely when the cluster is already at the cap", () => {
    const r = sizeAgainstClusterCap({
      currentWeights: { AAPL: 0.1, MSFT: 0.1 },
      proposedSymbol: "NVDA",
      proposedWeight: 0.05,
      clusters: [["AAPL", "MSFT", "NVDA"]],
      clusterCap: 0.2,
    });
    expect(r.allowed_weight).toBe(0);
    expect(r.scale).toBe(0);
    expect(r.breached_cap).toBe(true);
  });
});
