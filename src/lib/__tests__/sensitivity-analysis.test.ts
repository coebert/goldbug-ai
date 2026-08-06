import { describe, expect, it } from "vitest";
import {
  DEFAULT_INVESTED_TARGETS,
  DEFAULT_RISK_LEVELS,
  runSensitivityAnalysis,
  sensitivityGrid,
  simulateScenario,
  type ScenarioMetrics,
} from "../sensitivity-analysis";

/** Deterministic tape: steady drift with a deep mid-sample drawdown. */
function tape(bars = 504): number[] {
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const drift = 0.0006;
    const wave = 0.012 * Math.sin(i / 7);
    const crash = i >= 200 && i < 240 ? -0.008 : 0;
    out.push(drift + wave + crash);
  }
  return out;
}

const flatMetrics = (netCagrPct: number, maxDrawdownPct: number): ScenarioMetrics => ({
  netCagrPct,
  maxDrawdownPct,
  volatilityPct: 10,
  sharpe: 1,
  avgExposure: 0.5,
  haltedBars: 0,
  feeDragPct: 1,
});

describe("simulateScenario", () => {
  it("is deterministic", () => {
    const a = simulateScenario(tape(), { riskLevel: 3, investedTarget: 0.6 });
    const b = simulateScenario(tape(), { riskLevel: 3, investedTarget: 0.6 });
    expect(a).toEqual(b);
  });

  it("zero invested target earns only the cash yield and takes no drawdown", () => {
    const m = simulateScenario(tape(252), { riskLevel: 3, investedTarget: 0 }, { cashYieldPct: 4 });
    expect(m.avgExposure).toBe(0);
    expect(m.maxDrawdownPct).toBe(0);
    expect(m.feeDragPct).toBeCloseTo(0, 6);
    expect(m.netCagrPct).toBeGreaterThan(3.5);
    expect(m.netCagrPct).toBeLessThan(4.5);
  });

  it("more invested target means deeper drawdown on a losing stretch", () => {
    const low = simulateScenario(tape(), { riskLevel: 3, investedTarget: 0.3 });
    const high = simulateScenario(tape(), { riskLevel: 3, investedTarget: 0.9 });
    expect(high.maxDrawdownPct).toBeLessThan(low.maxDrawdownPct);
    expect(high.avgExposure).toBeGreaterThan(low.avgExposure);
  });

  it("charges more cost drag as exposure rises", () => {
    const low = simulateScenario(tape(), { riskLevel: 3, investedTarget: 0.3 });
    const high = simulateScenario(tape(), { riskLevel: 3, investedTarget: 0.9 });
    expect(high.feeDragPct).toBeGreaterThan(low.feeDragPct);
  });

  it("the dial size multiplier scales realised exposure", () => {
    const timid = simulateScenario(tape(), { riskLevel: 1, investedTarget: 0.6 });
    const bold = simulateScenario(tape(), { riskLevel: 5, investedTarget: 0.6 });
    expect(bold.avgExposure).toBeGreaterThan(timid.avgExposure);
  });

  it("fires the drawdown halt on a deep tape at a tight dial", () => {
    const crash = Array.from({ length: 120 }, () => -0.01);
    const m = simulateScenario(crash, { riskLevel: 1, investedTarget: 0.9 });
    expect(m.haltedBars).toBeGreaterThan(0);
  });

  it("rejects invalid inputs", () => {
    expect(() => simulateScenario([0.01], { riskLevel: 3, investedTarget: 1.4 })).toThrow();
    expect(() =>
      simulateScenario([0.01], { riskLevel: 3, investedTarget: 0.5 }, { barsPerYear: 0 }),
    ).toThrow();
  });
});

describe("runSensitivityAnalysis", () => {
  it("covers the full grid with cash targets complementing invested targets", () => {
    const r = runSensitivityAnalysis(tape());
    expect(r.cells).toHaveLength(DEFAULT_RISK_LEVELS.length * DEFAULT_INVESTED_TARGETS.length);
    for (const c of r.cells) {
      expect(c.cashTarget).toBeCloseTo(1 - c.investedTarget, 10);
      expect(c.riskName).toBeTruthy();
    }
  });

  it("marks cells against the drawdown budget", () => {
    const r = runSensitivityAnalysis(tape(), { drawdownBudgetPct: 5 });
    for (const c of r.cells) {
      expect(c.withinBudget).toBe(c.metrics.maxDrawdownPct >= -5);
    }
    if (r.bestWithinBudget) expect(r.bestWithinBudget.metrics.maxDrawdownPct).toBeGreaterThanOrEqual(-5);
  });

  it("returns no in-budget winner when the budget is unreachable", () => {
    const r = runSensitivityAnalysis(tape(), { drawdownBudgetPct: 0.0001 });
    expect(r.bestWithinBudget).toBeNull();
    expect(r.sentence).toContain("No configuration");
  });

  it("drawdown deepens as the invested target rises", () => {
    const r = runSensitivityAnalysis(tape());
    const m = r.byInvestedTarget.marginals;
    expect(m[0]!.meanMaxDrawdownPct).toBeGreaterThan(m[m.length - 1]!.meanMaxDrawdownPct);
    expect(r.byInvestedTarget.drawdownSlope).toBeLessThan(0);
  });

  it("picks the best and safest cells consistently", () => {
    const r = runSensitivityAnalysis(tape());
    expect(Math.max(...r.cells.map((c) => c.metrics.netCagrPct))).toBeCloseTo(
      r.bestCagr.metrics.netCagrPct,
      10,
    );
    expect(Math.max(...r.cells.map((c) => c.metrics.maxDrawdownPct))).toBeCloseTo(
      r.safest.metrics.maxDrawdownPct,
      10,
    );
  });

  it("honours an injected evaluator and ranks the dominant axis by CAGR spread", () => {
    const r = runSensitivityAnalysis([0.01, -0.01], {
      riskLevels: [1, 5],
      investedTargets: [0.2, 0.8],
      evaluate: ({ riskLevel, investedTarget }) =>
        flatMetrics(riskLevel * 4 + investedTarget, -5),
    });
    expect(r.dominantAxis).toBe("riskLevel");
    expect(r.tornado[0]!.axis).toBe("riskLevel");
    expect(r.tornado).toHaveLength(2);
    expect(r.byRiskLevel.cagrRange).toBeCloseTo(16, 6);
  });

  it("flips the dominant axis when the cash target drives returns", () => {
    const r = runSensitivityAnalysis([0.01, -0.01], {
      riskLevels: [1, 5],
      investedTargets: [0.2, 0.8],
      evaluate: ({ riskLevel, investedTarget }) =>
        flatMetrics(investedTarget * 50 + riskLevel * 0.1, -5),
    });
    expect(r.dominantAxis).toBe("investedTarget");
  });

  it("validates axes and tape length", () => {
    expect(() => runSensitivityAnalysis([0.01])).toThrow();
    expect(() => runSensitivityAnalysis(tape(), { riskLevels: [] })).toThrow();
    expect(() => runSensitivityAnalysis(tape(), { investedTargets: [] })).toThrow();
  });

  it("summarises in plain language", () => {
    const r = runSensitivityAnalysis(tape(), { drawdownBudgetPct: 40 });
    expect(r.sentence).toMatch(/net CAGR/);
    expect(r.sentence).toMatch(/drawdown budget/);
  });
});

describe("sensitivityGrid", () => {
  it("shapes rows by risk level and columns by invested target", () => {
    const r = runSensitivityAnalysis(tape());
    const grid = sensitivityGrid(r, "maxDrawdownPct");
    expect(grid).toHaveLength(r.riskLevels.length);
    expect(grid[0]!.values.map((v) => v.investedTarget)).toEqual(r.investedTargets);
    const cell = r.cells.find(
      (c) => c.riskLevel === grid[0]!.riskLevel && c.investedTarget === r.investedTargets[0],
    )!;
    expect(grid[0]!.values[0]!.value).toBeCloseTo(cell.metrics.maxDrawdownPct, 10);
  });
});
