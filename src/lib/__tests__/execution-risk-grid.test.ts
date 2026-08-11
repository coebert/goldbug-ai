import { describe, expect, it } from "vitest";
import {
  DEFAULT_RISK_GRID_OPTIONS,
  dominates,
  formatRiskGrid,
  paretoFrontier,
  returnPerDrawdown,
  riskGridLevels,
  riskGridReport,
  riskSizingFor,
  type RiskGridRow,
} from "../execution-risk-grid";

const row = (risk: number, returnPct: number, drawdownPct: number): RiskGridRow => ({
  risk,
  sizing: riskSizingFor(risk),
  returnPct,
  cvar5Pct: returnPct - 5,
  drawdownPct,
  worstDrawdownPct: drawdownPct - 5,
  breachProb: 0,
  cost: 100,
  fills: 20,
});

describe("riskSizingFor", () => {
  it("is monotone: more risk means fewer slots and more deployment", () => {
    const levels = riskGridLevels(11);
    let prevSlots = Infinity;
    let prevDeploy = -Infinity;
    for (const l of levels) {
      const s = riskSizingFor(l);
      expect(s.maxPositions).toBeLessThanOrEqual(prevSlots);
      expect(s.exposureFraction).toBeGreaterThanOrEqual(prevDeploy);
      prevSlots = s.maxPositions;
      prevDeploy = s.exposureFraction;
    }
  });

  it("hits the configured endpoints exactly", () => {
    expect(riskSizingFor(0)).toEqual({
      maxPositions: DEFAULT_RISK_GRID_OPTIONS.maxPositionsAtLow,
      exposureFraction: DEFAULT_RISK_GRID_OPTIONS.exposureAtLow,
    });
    expect(riskSizingFor(1)).toEqual({
      maxPositions: DEFAULT_RISK_GRID_OPTIONS.maxPositionsAtHigh,
      exposureFraction: DEFAULT_RISK_GRID_OPTIONS.exposureAtHigh,
    });
  });

  it("clamps out-of-range dials and never allows zero positions", () => {
    expect(riskSizingFor(-3)).toEqual(riskSizingFor(0));
    expect(riskSizingFor(9)).toEqual(riskSizingFor(1));
    expect(riskSizingFor(1, { ...DEFAULT_RISK_GRID_OPTIONS, maxPositionsAtHigh: 0 }).maxPositions)
      .toBe(1);
  });
});

describe("riskGridLevels", () => {
  it("spans both endpoints and dedupes", () => {
    expect(riskGridLevels(5)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(riskGridLevels(1)).toEqual([0]);
    expect(riskGridLevels(3, 0.4, 0.8)).toEqual([0.4, 0.6, 0.8]);
  });

  it("rejects a degenerate grid", () => {
    expect(() => riskGridLevels(0)).toThrow(/at least 1 step/);
  });
});

describe("pareto frontier", () => {
  it("drops points beaten on both profit and drawdown", () => {
    const better = row(0.5, 10, -8);
    const worse = row(0.6, 6, -12);
    expect(dominates(better, worse)).toBe(true);
    expect(dominates(worse, better)).toBe(false);
    expect(paretoFrontier([better, worse]).map((r) => r.risk)).toEqual([0.5]);
  });

  it("keeps a point that trades one axis for the other", () => {
    const safe = row(0.2, 4, -5);
    const punchy = row(0.9, 12, -20);
    expect(paretoFrontier([safe, punchy]).map((r) => r.risk)).toEqual([0.2, 0.9]);
  });

  it("keeps exact ties rather than arbitrarily dropping one", () => {
    const a = row(0.3, 7, -9);
    const b = row(0.7, 7, -9);
    expect(dominates(a, b)).toBe(false);
    expect(paretoFrontier([a, b])).toHaveLength(2);
  });

  it("orders the frontier from shallowest to deepest drawdown", () => {
    const rows = [row(0.9, 12, -20), row(0.2, 4, -5), row(0.5, 8, -11)];
    expect(paretoFrontier(rows).map((r) => r.drawdownPct)).toEqual([-5, -11, -20]);
  });
});

describe("riskGridReport", () => {
  it("nominates the best return-per-drawdown frontier point as the knee", () => {
    const rows = [row(0.2, 4, -5), row(0.5, 8, -8), row(0.9, 12, -20)];
    const report = riskGridReport(rows, 15);
    expect(report.knee?.risk).toBe(0.5);
    expect(returnPerDrawdown(rows[1]!)).toBeCloseTo(1, 10);
    expect(report.dominated).toHaveLength(0);
  });

  it("reports no knee when nothing on the frontier makes money", () => {
    const report = riskGridReport([row(0.2, -1, -5), row(0.8, -4, -9)], 15);
    expect(report.knee).toBeNull();
    expect(report.lossMaking).toHaveLength(report.frontier.length);
    expect(formatRiskGrid(report)).toContain("no frontier point is profitable");
  });

  it("separates dominated levels from survivors and sorts rows by risk", () => {
    const rows = [row(0.9, 2, -25), row(0.1, 5, -4), row(0.5, 8, -9)];
    const report = riskGridReport(rows, 15);
    expect(report.rows.map((r) => r.risk)).toEqual([0.1, 0.5, 0.9]);
    expect(report.dominated.map((r) => r.risk)).toEqual([0.9]);
  });

  it("refuses an empty grid instead of inventing a frontier", () => {
    expect(() => riskGridReport([], 15)).toThrow(/at least one scored risk level/);
  });

  it("renders every level with a pareto marker on survivors only", () => {
    const out = formatRiskGrid(riskGridReport([row(0.1, 5, -4), row(0.9, 2, -25)], 15));
    const lines = out.split("\n");
    expect(lines.find((l) => l.startsWith("0.10"))).toContain("★ knee");
    expect(lines.find((l) => l.startsWith("0.90"))?.trimEnd().endsWith("0")).toBe(true);
    expect(out).toContain("Pareto frontier (1/2 risk levels survive)");
  });
});
