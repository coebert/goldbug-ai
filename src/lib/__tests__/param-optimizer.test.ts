import { describe, expect, it } from "vitest";
import {
  applyParams,
  averageMetrics,
  axisImpact,
  bestFeasible,
  enumerateGrid,
  evaluateConstraints,
  formatParams,
  formatResult,
  paretoFrontier,
  rankResults,
  sampleGrid,
  scoreAll,
  scoreCandidate,
  type CandidateMetrics,
  type OptimizerConstraints,
  type ParamAxis,
  type ParamSet,
} from "../param-optimizer";
import { DEFAULT_RISK_CONFIG } from "../universe.server";
import type { RunAudit } from "../trading-style-backtest";

const SLEEVE = { maxNames: 7, perNameWeight: 0.18 };

const cleanAudit: RunAudit = {
  minCash: 120,
  minQuantity: 0,
  maxGrossExposurePct: 92,
  rejections: {},
  clean: true,
};

function metrics(over: Partial<CandidateMetrics> = {}): CandidateMetrics {
  return {
    cagrPct: 9,
    totalReturnPct: 30,
    maxDrawdownPct: -14,
    sharpe: 0.8,
    trades: 120,
    tradesPerYear: 60,
    feeDragPct: 2,
    finalCashPct: 12,
    audit: cleanAudit,
    ...over,
  };
}

const CONSTRAINTS: OptimizerConstraints = {
  maxTradesPerYear: 100,
  maxDrawdownPct: 25,
  minTrades: 10,
};

describe("applyParams", () => {
  it("patches RiskConfig fields and leaves the rest untouched", () => {
    const { cfg } = applyParams(DEFAULT_RISK_CONFIG, SLEEVE, {
      stop_loss_pct: 0.06,
      take_profit_pct: 0.3,
    });
    expect(cfg.stop_loss_pct).toBe(0.06);
    expect(cfg.take_profit_pct).toBe(0.3);
    expect(cfg.chandelier_k_base).toBe(DEFAULT_RISK_CONFIG.chandelier_k_base);
    // The base config must not be mutated.
    expect(DEFAULT_RISK_CONFIG.stop_loss_pct).toBe(0.1);
  });

  it("routes sleeve keys away from the risk config", () => {
    const { cfg, sleeve } = applyParams(DEFAULT_RISK_CONFIG, SLEEVE, {
      max_names: 4,
      per_name_weight: 0.2,
    });
    expect(sleeve).toEqual({ maxNames: 4, perNameWeight: 0.2 });
    expect(cfg).not.toHaveProperty("max_names");
  });

  it("clamps the sleeve so the book can never exceed 100% of equity", () => {
    const { sleeve } = applyParams(DEFAULT_RISK_CONFIG, SLEEVE, {
      max_names: 8,
      per_name_weight: 0.4,
    });
    expect(sleeve.maxNames * sleeve.perNameWeight).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("rejects unknown parameters instead of silently ignoring them", () => {
    expect(() =>
      applyParams(DEFAULT_RISK_CONFIG, SLEEVE, { not_a_real_knob: 1 } as ParamSet),
    ).toThrow(/unknown parameter/);
  });
});

describe("enumerateGrid / sampleGrid", () => {
  const axes: ParamAxis[] = [
    { key: "stop_loss_pct", values: [0.06, 0.1] },
    { key: "max_names", values: [4, 6, 8] },
  ];

  it("produces the full cartesian product in stable order", () => {
    const grid = enumerateGrid(axes);
    expect(grid).toHaveLength(6);
    expect(grid[0]).toEqual({ stop_loss_pct: 0.06, max_names: 4 });
    expect(grid.at(-1)).toEqual({ stop_loss_pct: 0.1, max_names: 8 });
  });

  it("throws on an empty axis", () => {
    expect(() => enumerateGrid([{ key: "x", values: [] }])).toThrow(/no values/);
  });

  it("returns the whole grid when it fits under the limit", () => {
    expect(sampleGrid(axes, 100)).toEqual(enumerateGrid(axes));
  });

  it("samples deterministically and spreads across axes", () => {
    const a = sampleGrid(axes, 3, 42);
    const b = sampleGrid(axes, 3, 42);
    expect(a).toEqual(b);
    expect(a).toHaveLength(3);
    expect(sampleGrid(axes, 3, 7)).not.toEqual(a);
    // Sampling must not just take the first-axis prefix.
    const big: ParamAxis[] = [
      { key: "a", values: [1, 2, 3, 4, 5] },
      { key: "b", values: [1, 2, 3, 4, 5] },
    ];
    const sampled = sampleGrid(big, 8, 1);
    expect(new Set(sampled.map((s) => s["a"])).size).toBeGreaterThan(1);
    expect(new Set(sampled.map((s) => s["b"])).size).toBeGreaterThan(1);
  });
});

describe("evaluateConstraints", () => {
  it("accepts a candidate inside every limit", () => {
    const c = evaluateConstraints(metrics(), CONSTRAINTS);
    expect(c).toMatchObject({ feasible: true, disqualified: false });
    expect(c.violations).toEqual([]);
  });

  it("flags a turnover breach without disqualifying", () => {
    const c = evaluateConstraints(metrics({ tradesPerYear: 400 }), CONSTRAINTS);
    expect(c.feasible).toBe(false);
    expect(c.disqualified).toBe(false);
    expect(c.violations[0]).toMatch(/turnover/);
  });

  it("flags a drawdown breach and a thin sample", () => {
    const c = evaluateConstraints(metrics({ maxDrawdownPct: -41, trades: 3 }), CONSTRAINTS);
    expect(c.violations.some((v) => v.includes("drawdown"))).toBe(true);
    expect(c.violations.some((v) => v.includes("trades"))).toBe(true);
  });

  it("disqualifies borrowing, shorting and leverage", () => {
    const borrow = evaluateConstraints(
      metrics({ audit: { ...cleanAudit, minCash: -500, clean: false } }),
      CONSTRAINTS,
    );
    const short = evaluateConstraints(
      metrics({ audit: { ...cleanAudit, minQuantity: -4, clean: false } }),
      CONSTRAINTS,
    );
    const levered = evaluateConstraints(
      metrics({ audit: { ...cleanAudit, maxGrossExposurePct: 143, clean: false } }),
      CONSTRAINTS,
    );
    expect(borrow.disqualified).toBe(true);
    expect(short.disqualified).toBe(true);
    expect(levered.disqualified).toBe(true);
    expect(borrow.feasible).toBe(false);
  });

  it("can be run with the leverage audit disabled", () => {
    const c = evaluateConstraints(metrics({ audit: { ...cleanAudit, minCash: -500 } }), {
      ...CONSTRAINTS,
      enforceNoLeverage: false,
    });
    expect(c.disqualified).toBe(false);
    expect(c.feasible).toBe(true);
  });
});

describe("scoring and ranking", () => {
  it("scores feasible candidates by net CAGR", () => {
    const m = metrics({ cagrPct: 11.5 });
    expect(scoreCandidate(m, evaluateConstraints(m, CONSTRAINTS))).toBeCloseTo(11.5);
  });

  it("ranks every feasible candidate above every infeasible one", () => {
    const scored = scoreAll(
      [
        { params: { a: 1 }, metrics: metrics({ cagrPct: 40, tradesPerYear: 500 }) },
        { params: { a: 2 }, metrics: metrics({ cagrPct: 4 }) },
      ],
      CONSTRAINTS,
    );
    const ranked = rankResults(scored);
    expect(ranked[0]!.params).toEqual({ a: 2 });
    expect(ranked[1]!.check.feasible).toBe(false);
  });

  it("never lets a levered candidate win", () => {
    const scored = scoreAll(
      [
        {
          params: { a: 1 },
          metrics: metrics({
            cagrPct: 99,
            audit: { ...cleanAudit, maxGrossExposurePct: 180, clean: false },
          }),
        },
        { params: { a: 2 }, metrics: metrics({ cagrPct: 3 }) },
      ],
      CONSTRAINTS,
    );
    expect(bestFeasible(scored)!.params).toEqual({ a: 2 });
    expect(rankResults(scored).at(-1)!.check.disqualified).toBe(true);
  });

  it("breaks CAGR ties in favour of lower turnover", () => {
    const scored = scoreAll(
      [
        { params: { a: 1 }, metrics: metrics({ cagrPct: 8, tradesPerYear: 90 }) },
        { params: { a: 2 }, metrics: metrics({ cagrPct: 8, tradesPerYear: 20 }) },
      ],
      CONSTRAINTS,
    );
    expect(rankResults(scored)[0]!.params).toEqual({ a: 2 });
  });

  it("returns null when nothing is feasible", () => {
    const scored = scoreAll(
      [{ params: { a: 1 }, metrics: metrics({ tradesPerYear: 900 }) }],
      CONSTRAINTS,
    );
    expect(bestFeasible(scored)).toBeNull();
  });
});

describe("paretoFrontier", () => {
  it("keeps only non-dominated (CAGR ↑, turnover ↓) points", () => {
    const scored = scoreAll(
      [
        { params: { a: 1 }, metrics: metrics({ cagrPct: 5, tradesPerYear: 20 }) },
        { params: { a: 2 }, metrics: metrics({ cagrPct: 9, tradesPerYear: 60 }) },
        { params: { a: 3 }, metrics: metrics({ cagrPct: 4, tradesPerYear: 80 }) }, // dominated
      ],
      CONSTRAINTS,
    );
    const front = paretoFrontier(scored);
    expect(front.map((r) => r.params["a"])).toEqual([1, 2]);
  });

  it("excludes disqualified candidates from the frontier", () => {
    const scored = scoreAll(
      [
        {
          params: { a: 1 },
          metrics: metrics({
            cagrPct: 50,
            tradesPerYear: 5,
            audit: { ...cleanAudit, minCash: -1, clean: false },
          }),
        },
        { params: { a: 2 }, metrics: metrics({ cagrPct: 6, tradesPerYear: 30 }) },
      ],
      CONSTRAINTS,
    );
    expect(paretoFrontier(scored).map((r) => r.params["a"])).toEqual([2]);
  });
});

describe("axisImpact", () => {
  it("reports mean CAGR per level and identifies the best", () => {
    const scored = scoreAll(
      [
        { params: { stop_loss_pct: 0.06 }, metrics: metrics({ cagrPct: 4 }) },
        { params: { stop_loss_pct: 0.06 }, metrics: metrics({ cagrPct: 6 }) },
        { params: { stop_loss_pct: 0.1 }, metrics: metrics({ cagrPct: 12 }) },
      ],
      CONSTRAINTS,
    );
    const im = axisImpact(scored, "stop_loss_pct");
    expect(im.levels.map((l) => l.meanCagrPct)).toEqual([5, 12]);
    expect(im.bestValue).toBe(0.1);
    expect(im.spreadPct).toBeCloseTo(7);
  });

  it("returns an empty impact for an axis that was not swept", () => {
    const scored = scoreAll([{ params: { a: 1 }, metrics: metrics() }], CONSTRAINTS);
    expect(axisImpact(scored, "take_profit_pct")).toMatchObject({ bestValue: null, spreadPct: 0 });
  });
});

describe("averageMetrics", () => {
  it("averages folds and merges the audit conservatively", () => {
    const avg = averageMetrics([
      metrics({ cagrPct: 10, tradesPerYear: 40 }),
      metrics({
        cagrPct: 20,
        tradesPerYear: 80,
        audit: { ...cleanAudit, minCash: -3, maxGrossExposurePct: 101, clean: false },
      }),
    ]);
    expect(avg.cagrPct).toBe(15);
    expect(avg.tradesPerYear).toBe(60);
    expect(avg.audit!.minCash).toBe(-3);
    expect(avg.audit!.maxGrossExposurePct).toBe(101);
    expect(avg.audit!.clean).toBe(false);
  });

  it("sums rejection counts across folds", () => {
    const avg = averageMetrics([
      metrics({ audit: { ...cleanAudit, rejections: { insufficient_cash: 2 } } }),
      metrics({ audit: { ...cleanAudit, rejections: { insufficient_cash: 3, would_short: 1 } } }),
    ]);
    expect(avg.audit!.rejections).toEqual({ insufficient_cash: 5, would_short: 1 });
  });

  it("throws on an empty fold list", () => {
    expect(() => averageMetrics([])).toThrow(/no runs/);
  });
});

describe("formatting", () => {
  it("renders params and a result line", () => {
    expect(formatParams({ stop_loss_pct: 0.06, max_names: 6 })).toBe(
      "stop_loss_pct=0.06 max_names=6",
    );
    const scored = scoreAll(
      [{ params: { max_names: 6 }, metrics: metrics({ tradesPerYear: 500 }) }],
      CONSTRAINTS,
    );
    const line = formatResult(scored[0]!);
    expect(line).toContain("CAGR");
    expect(line).toContain("infeasible");
    expect(line).toContain("max_names=6");
  });
});
