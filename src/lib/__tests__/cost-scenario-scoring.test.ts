import { describe, it, expect } from "vitest";
import {
  aggregateScenarioMetrics,
  costRobustness,
  describeCostScoreMode,
  describeRobustness,
  scenarioCostBps,
  type ScenarioRun,
} from "../cost-scenario-scoring";
import { buildCostGrid, scenarioKey } from "../cost-sweep";
import type { CandidateMetrics } from "../param-optimizer";

const m = (over: Partial<CandidateMetrics> = {}): CandidateMetrics => ({
  cagrPct: 5,
  totalReturnPct: 20,
  maxDrawdownPct: -10,
  sharpe: 0.8,
  trades: 40,
  tradesPerYear: 50,
  feeDragPct: 2,
  finalCashPct: 10,
  ...over,
});

const run = (scenario: string, over: Partial<CandidateMetrics> = {}, extra: Partial<ScenarioRun> = {}): ScenarioRun => ({
  scenario,
  metrics: m(over),
  ...extra,
});

const BASE = { commissionBps: 8, minCommission: 3, buyTaxBps: 0, slippageBps: 5, impactPerUnit: 0.0002 };

describe("aggregateScenarioMetrics", () => {
  const runs = [
    run("cheap", { cagrPct: 9, maxDrawdownPct: -8, tradesPerYear: 40, feeDragPct: 1, sharpe: 1.2, finalCashPct: 12 }),
    run("mid", { cagrPct: 4, maxDrawdownPct: -14, tradesPerYear: 55, feeDragPct: 3, sharpe: 0.6, finalCashPct: 8 }),
    run("brutal", { cagrPct: -2, maxDrawdownPct: -21, tradesPerYear: 60, feeDragPct: 6, sharpe: -0.2, finalCashPct: 4 }),
  ];

  it("defaults to the mean of return metrics", () => {
    const agg = aggregateScenarioMetrics(runs);
    expect(agg.cagrPct).toBeCloseTo((9 + 4 - 2) / 3, 10);
    expect(agg.sharpe).toBeCloseTo((1.2 + 0.6 - 0.2) / 3, 10);
  });

  it("uses the worst scenario in worst mode", () => {
    expect(aggregateScenarioMetrics(runs, { mode: "worst" }).cagrPct).toBe(-2);
  });

  it("averages the worst tail in cvar mode", () => {
    // tailShare 2/3 of 3 scenarios = worst 2
    const agg = aggregateScenarioMetrics(runs, { mode: "cvar", tailShare: 2 / 3 });
    expect(agg.cagrPct).toBeCloseTo((4 - 2) / 2, 10);
  });

  it("clamps tail share into [0,1] and always keeps at least one scenario", () => {
    expect(aggregateScenarioMetrics(runs, { mode: "cvar", tailShare: 0 }).cagrPct).toBe(-2);
    expect(aggregateScenarioMetrics(runs, { mode: "cvar", tailShare: 5 }).cagrPct).toBeCloseTo(
      (9 + 4 - 2) / 3,
      10,
    );
  });

  it("honours weights in weighted mode", () => {
    const weighted = aggregateScenarioMetrics(
      [
        run("a", { cagrPct: 10 }, { weight: 3 }),
        run("b", { cagrPct: 2 }, { weight: 1 }),
      ],
      { mode: "weighted" },
    );
    expect(weighted.cagrPct).toBeCloseTo((10 * 3 + 2) / 4, 10);
  });

  it("rejects negative or all-zero weights", () => {
    expect(() =>
      aggregateScenarioMetrics([run("a", {}, { weight: -1 })], { mode: "weighted" }),
    ).toThrow(/invalid weight/);
    expect(() =>
      aggregateScenarioMetrics([run("a", {}, { weight: 0 })], { mode: "weighted" }),
    ).toThrow(/sum to zero/);
  });

  it("always takes risk and cost metrics from the worst scenario", () => {
    for (const mode of ["mean", "worst", "cvar", "weighted"] as const) {
      const agg = aggregateScenarioMetrics(runs, { mode });
      expect(agg.maxDrawdownPct).toBe(-21);
      expect(agg.tradesPerYear).toBe(60);
      expect(agg.feeDragPct).toBe(6);
      expect(agg.finalCashPct).toBe(4);
    }
  });

  it("averages trade count, which is a policy property not a cost one", () => {
    const agg = aggregateScenarioMetrics([run("a", { trades: 10 }), run("b", { trades: 20 })]);
    expect(agg.trades).toBe(15);
  });

  it("merges audits pessimistically so one bad scenario disqualifies", () => {
    const clean = { minCash: 100, minQuantity: 0, maxGrossExposurePct: 90, rejections: { cash: 1 }, clean: true };
    const dirty = { minCash: -5, minQuantity: -2, maxGrossExposurePct: 120, rejections: { cash: 2 }, clean: false };
    const agg = aggregateScenarioMetrics([run("a", { audit: clean }), run("b", { audit: dirty })]);
    expect(agg.audit).toEqual({
      minCash: -5,
      minQuantity: -2,
      maxGrossExposurePct: 120,
      rejections: { cash: 3 },
      clean: false,
    });
  });

  it("omits the audit when no scenario reported one", () => {
    expect(aggregateScenarioMetrics([run("a")]).audit).toBeUndefined();
  });

  it("is identity-preserving for a single scenario's return metrics", () => {
    const only = run("solo", { cagrPct: 7.5, sharpe: 1.1, totalReturnPct: 33 });
    const agg = aggregateScenarioMetrics([only]);
    expect(agg.cagrPct).toBe(7.5);
    expect(agg.sharpe).toBe(1.1);
    expect(agg.totalReturnPct).toBe(33);
  });

  it("throws on an empty scenario list", () => {
    expect(() => aggregateScenarioMetrics([])).toThrow(/no scenario runs/);
  });

  it("never scores above the mean when using worst or cvar", () => {
    const mean = aggregateScenarioMetrics(runs, { mode: "mean" }).cagrPct;
    expect(aggregateScenarioMetrics(runs, { mode: "worst" }).cagrPct).toBeLessThanOrEqual(mean);
    expect(aggregateScenarioMetrics(runs, { mode: "cvar" }).cagrPct).toBeLessThanOrEqual(mean);
  });
});

describe("costRobustness", () => {
  const runs = [
    run("s1", { cagrPct: 8, maxDrawdownPct: -9, tradesPerYear: 30, feeDragPct: 1 }, { label: "cheap", scale: 10 }),
    run("s2", { cagrPct: 3, maxDrawdownPct: -15, tradesPerYear: 45, feeDragPct: 3 }, { label: "mid", scale: 20 }),
    run("s3", { cagrPct: -1, maxDrawdownPct: -22, tradesPerYear: 50, feeDragPct: 5 }, { label: "brutal", scale: 30 }),
  ];

  it("reports the spread and the extremes with their labels", () => {
    const rb = costRobustness(runs);
    expect(rb.scenarios).toBe(3);
    expect(rb.worstCagrPct).toBe(-1);
    expect(rb.bestCagrPct).toBe(8);
    expect(rb.cagrSpreadPct).toBeCloseTo(9, 10);
    expect(rb.worstScenario).toBe("brutal");
    expect(rb.bestScenario).toBe("cheap");
  });

  it("takes worst-case risk metrics", () => {
    const rb = costRobustness(runs);
    expect(rb.worstDrawdownPct).toBe(-22);
    expect(rb.worstTradesPerYear).toBe(50);
    expect(rb.worstFeeDragPct).toBe(5);
  });

  it("counts profitable cost worlds against the threshold", () => {
    expect(costRobustness(runs).profitableShare).toBeCloseTo(2 / 3, 10);
    expect(costRobustness(runs, { minCagrPct: 5 }).profitableShare).toBeCloseTo(1 / 3, 10);
    expect(costRobustness(runs, { minCagrPct: -100 }).profitableShare).toBe(1);
  });

  it("fits a negative slope of CAGR against cost", () => {
    const rb = costRobustness(runs);
    expect(rb.cagrPerCostBps).not.toBeNull();
    expect(rb.cagrPerCostBps!).toBeLessThan(0);
  });

  it("prefers an explicit cost map over the scale field", () => {
    const rb = costRobustness(runs, { costBpsByScenario: { s1: 100, s2: 200, s3: 300 } });
    // Same ordering, ten times the x-spread → a tenth of the slope.
    expect(rb.cagrPerCostBps!).toBeCloseTo(costRobustness(runs).cagrPerCostBps! / 10, 6);
  });

  it("returns a null slope when the cost axis has no spread", () => {
    const flat = [run("a", { cagrPct: 4 }, { scale: 10 }), run("b", { cagrPct: 6 }, { scale: 10 })];
    expect(costRobustness(flat).cagrPerCostBps).toBeNull();
    expect(costRobustness([run("solo", {}, { scale: 5 })]).cagrPerCostBps).toBeNull();
  });

  it("falls back to the scenario id when no label is given", () => {
    expect(costRobustness([run("only-id", { cagrPct: 1 })]).worstScenario).toBe("only-id");
  });

  it("throws on an empty scenario list", () => {
    expect(() => costRobustness([])).toThrow(/no scenario runs/);
  });
});

describe("scenarioCostBps", () => {
  it("sums commission, tax and per-side slippage for a flat scenario", () => {
    const [sc] = buildCostGrid(BASE, { scales: [1] });
    expect(scenarioCostBps(sc!)).toBeCloseTo(8 + 0 + 5, 6);
  });

  it("uses the slippage spec when the slippage axis is varied", () => {
    const grid = buildCostGrid(BASE, {
      scales: [1],
      slippage: [{ label: "20bps", slippageBps: 10, spreadBps: 10 }],
    });
    expect(scenarioCostBps(grid[0]!)).toBeCloseTo(8 + 20, 6);
  });

  it("increases monotonically along the slippage and min-fee grid", () => {
    const grid = buildCostGrid(BASE, {
      scales: [1],
      slippage: [
        { label: "4bps", slippageBps: 2, spreadBps: 2 },
        { label: "20bps", slippageBps: 10, spreadBps: 10 },
      ],
      minCommission: [0, 8],
    });
    const keys = grid.map((sc) => scenarioKey(sc));
    expect(new Set(keys).size).toBe(grid.length);
    const cheap = grid.filter((sc) => sc.slippage?.label === "4bps");
    const dear = grid.filter((sc) => sc.slippage?.label === "20bps");
    expect(Math.max(...cheap.map(scenarioCostBps))).toBeLessThan(
      Math.min(...dear.map(scenarioCostBps)),
    );
  });
});

describe("describe helpers", () => {
  it("names each aggregation mode", () => {
    expect(describeCostScoreMode("mean")).toMatch(/mean across/);
    expect(describeCostScoreMode("worst")).toMatch(/worst-case/);
    expect(describeCostScoreMode("cvar", 0.5)).toMatch(/worst 50%/);
    expect(describeCostScoreMode("weighted")).toMatch(/weighted/);
  });

  it("summarises robustness in one line", () => {
    const line = describeRobustness(
      costRobustness([
        run("a", { cagrPct: 6 }, { label: "cheap", scale: 10 }),
        run("b", { cagrPct: -2 }, { label: "brutal", scale: 30 }),
      ]),
    );
    expect(line).toContain("2 scenarios");
    expect(line).toContain("brutal");
    expect(line).toContain("50% of cost worlds profitable");
  });
});
