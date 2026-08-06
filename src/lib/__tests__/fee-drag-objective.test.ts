import { describe, it, expect } from "vitest";
import {
  annualiseFeeDragPct,
  avoidableDragPct,
  EMPTY_FEE_DRAG,
  feeAdjustedCagr,
  feeEfficiency,
  feeObjectiveForRegime,
  FEE_EFFICIENT_OBJECTIVE,
  formatFeeDrag,
  totalFeeDragPct,
  type FeeDragBreakdown,
} from "../fee-drag-objective";
import {
  annualFeeDrag,
  bestFeasible,
  compareObjectives,
  evaluateConstraints,
  feeParetoFrontier,
  objectiveValue,
  rankResults,
  scoreAll,
  type CandidateMetrics,
  type OptimizerConstraints,
} from "../param-optimizer";

const CONSTRAINTS: OptimizerConstraints = { maxTradesPerYear: 200, maxDrawdownPct: 20 };

const metrics = (o: Partial<CandidateMetrics> = {}): CandidateMetrics => ({
  cagrPct: 10,
  totalReturnPct: 21,
  maxDrawdownPct: -12,
  sharpe: 1,
  trades: 40,
  tradesPerYear: 20,
  feeDragPct: 4,
  finalCashPct: 5,
  years: 2,
  ...o,
});

const drag = (o: Partial<FeeDragBreakdown> = {}): FeeDragBreakdown => ({
  ...EMPTY_FEE_DRAG,
  commissionPct: 2,
  minFeePct: 1.2,
  slippagePct: 1,
  ...o,
});

describe("fee drag arithmetic", () => {
  it("counts the minimum-fee component inside commission, not on top of it", () => {
    expect(totalFeeDragPct(drag())).toBeCloseTo(3, 9);
    expect(totalFeeDragPct(drag({ otherPct: 0.5 }))).toBeCloseTo(3.5, 9);
  });

  it("annualises over the run horizon and tolerates a missing one", () => {
    expect(annualiseFeeDragPct(6, 3)).toBeCloseTo(2, 9);
    expect(annualiseFeeDragPct(6, undefined)).toBe(6);
    expect(annualiseFeeDragPct(6, 0)).toBe(6);
  });

  it("treats only the floors and slippage as avoidable", () => {
    expect(avoidableDragPct(drag(), 2)).toBeCloseTo((1.2 + 1) / 2, 9);
  });

  it("reports efficiency as return per point of fee", () => {
    expect(feeEfficiency(10, 2)).toBeCloseTo(5, 9);
    expect(feeEfficiency(10, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(feeEfficiency(-3, 2)).toBe(0);
  });

  it("penalises drag linearly and never rewards it", () => {
    expect(feeAdjustedCagr(10, 2, 1.5)).toBeCloseTo(7, 9);
    expect(feeAdjustedCagr(10, 0, 1.5)).toBe(10);
    expect(feeAdjustedCagr(10, -5, 1.5)).toBe(10);
  });

  it("leans hardest on fees in bull tapes and eases off in crises", () => {
    const bull = feeObjectiveForRegime("bull_trend").lambda;
    const neutral = feeObjectiveForRegime("neutral").lambda;
    const crisis = feeObjectiveForRegime("crisis").lambda;
    expect(bull).toBeGreaterThan(neutral);
    expect(crisis).toBeLessThan(neutral);
    expect(neutral).toBe(FEE_EFFICIENT_OBJECTIVE.lambda);
  });

  it("formats an annualised breakdown", () => {
    expect(formatFeeDrag(drag(), 2)).toBe(
      "fees 1.50%/yr (comm 1.00 of which min 0.60, slip 0.50, other 0.00)",
    );
  });
});

describe("fee-efficient optimiser objective", () => {
  it("defaults to plain net CAGR so existing callers are unaffected", () => {
    expect(objectiveValue(metrics())).toBe(10);
  });

  it("charges the annualised drag against CAGR", () => {
    // 4% over 2 years = 2%/yr, λ=1.5 → 10 - 3 = 7
    expect(objectiveValue(metrics(), FEE_EFFICIENT_OBJECTIVE)).toBeCloseTo(7, 9);
    expect(annualFeeDrag(metrics())).toBeCloseTo(2, 9);
  });

  it("prefers the cheaper config when gross returns are close", () => {
    const evaluated = [
      { params: { cfg: 1 }, metrics: metrics({ cagrPct: 11, feeDragPct: 10 }) },
      { params: { cfg: 2 }, metrics: metrics({ cagrPct: 10, feeDragPct: 2 }) },
    ];
    expect(bestFeasible(scoreAll(evaluated, CONSTRAINTS))!.params).toEqual({ cfg: 1 });
    const feeAware = bestFeasible(
      scoreAll(evaluated, CONSTRAINTS, { ...FEE_EFFICIENT_OBJECTIVE, maxAnnualFeeDragPct: 99 }),
    );
    expect(feeAware!.params).toEqual({ cfg: 2 });
  });

  it("still prefers a pricier config when it genuinely earns its keep", () => {
    const evaluated = [
      { params: { cfg: 1 }, metrics: metrics({ cagrPct: 25, feeDragPct: 10 }) },
      { params: { cfg: 2 }, metrics: metrics({ cagrPct: 10, feeDragPct: 2 }) },
    ];
    const winner = bestFeasible(
      scoreAll(evaluated, CONSTRAINTS, { ...FEE_EFFICIENT_OBJECTIVE, maxAnnualFeeDragPct: 99 }),
    );
    expect(winner!.params).toEqual({ cfg: 1 });
  });

  it("keeps the drawdown ceiling hard — cheapness cannot buy risk", () => {
    const evaluated = [
      { params: { cfg: "cheap_risky" }, metrics: metrics({ feeDragPct: 0, maxDrawdownPct: -35 }) },
      { params: { cfg: "safe" }, metrics: metrics({ cagrPct: 6, feeDragPct: 6 }) },
    ];
    const scored = scoreAll(evaluated, CONSTRAINTS, FEE_EFFICIENT_OBJECTIVE);
    expect(scored[0]!.check.feasible).toBe(false);
    expect(scored[0]!.check.violations[0]).toContain("drawdown");
    expect(bestFeasible(scored)!.params).toEqual({ cfg: "safe" });
  });

  it("makes an over-budget fee drag infeasible but not disqualified", () => {
    const check = evaluateConstraints(
      metrics({ feeDragPct: 20 }),
      CONSTRAINTS,
      FEE_EFFICIENT_OBJECTIVE,
    );
    expect(check.feasible).toBe(false);
    expect(check.disqualified).toBe(false);
    expect(check.violations.join()).toContain("fee drag 10.00%/yr > 6.00%/yr");
  });

  it("applies no fee constraint under the plain objective", () => {
    expect(evaluateConstraints(metrics({ feeDragPct: 20 }), CONSTRAINTS).feasible).toBe(true);
  });

  it("enforces a minimum fee efficiency when asked", () => {
    const objective = { ...FEE_EFFICIENT_OBJECTIVE, minFeeEfficiency: 4 };
    // 10% CAGR on 2%/yr of fees = 5x, clears.
    expect(evaluateConstraints(metrics(), CONSTRAINTS, objective).feasible).toBe(true);
    // 5% CAGR on 2%/yr = 2.5x, fails.
    expect(
      evaluateConstraints(metrics({ cagrPct: 5 }), CONSTRAINTS, objective).violations.join(),
    ).toContain("fee efficiency");
  });

  it("breaks ties on fee drag before turnover", () => {
    const ranked = rankResults(
      scoreAll(
        [
          { params: { cfg: "pricey" }, metrics: metrics({ feeDragPct: 6, tradesPerYear: 10 }) },
          { params: { cfg: "cheap" }, metrics: metrics({ feeDragPct: 1, tradesPerYear: 30 }) },
        ],
        CONSTRAINTS,
      ),
    );
    expect(ranked[0]!.params).toEqual({ cfg: "cheap" });
  });

  it("exposes the CAGR-vs-fees frontier", () => {
    const scored = scoreAll(
      [
        { params: { cfg: "a" }, metrics: metrics({ cagrPct: 8, feeDragPct: 1 }) },
        { params: { cfg: "b" }, metrics: metrics({ cagrPct: 12, feeDragPct: 5 }) },
        { params: { cfg: "dominated" }, metrics: metrics({ cagrPct: 7, feeDragPct: 6 }) },
      ],
      CONSTRAINTS,
    );
    const front = feeParetoFrontier(scored).map((r) => r.params["cfg"]);
    expect(front).toEqual(["a", "b"]);
  });

  it("quantifies what the fee-aware objective bought in a bull tape", () => {
    // Bull tape: everything makes money, the spread between configs is cost.
    const evaluated = [
      { params: { cfg: "churn" }, metrics: metrics({ cagrPct: 18.5, feeDragPct: 16 }) },
      { params: { cfg: "patient" }, metrics: metrics({ cagrPct: 18, feeDragPct: 3 }) },
    ];
    const cmp = compareObjectives(evaluated, CONSTRAINTS, {
      ...feeObjectiveForRegime("bull_trend"),
      maxAnnualFeeDragPct: 99,
    });
    expect(cmp.cagrWinner!.params).toEqual({ cfg: "churn" });
    expect(cmp.feeAwareWinner!.params).toEqual({ cfg: "patient" });
    expect(cmp.cagrGivenUpPct).toBeCloseTo(0.5, 6);
    expect(cmp.feeSavedPct).toBeCloseTo(6.5, 6);
    expect(cmp.objectiveGainPct).toBeGreaterThan(0);
  });

  it("is deterministic and order-independent", () => {
    const a = metrics({ cagrPct: 9, feeDragPct: 1 });
    const b = metrics({ cagrPct: 9.2, feeDragPct: 5 });
    const one = rankResults(
      scoreAll(
        [
          { params: { cfg: "a" }, metrics: a },
          { params: { cfg: "b" }, metrics: b },
        ],
        CONSTRAINTS,
        FEE_EFFICIENT_OBJECTIVE,
      ),
    ).map((r) => r.params["cfg"]);
    const two = rankResults(
      scoreAll(
        [
          { params: { cfg: "b" }, metrics: b },
          { params: { cfg: "a" }, metrics: a },
        ],
        CONSTRAINTS,
        FEE_EFFICIENT_OBJECTIVE,
      ),
    ).map((r) => r.params["cfg"]);
    expect(one).toEqual(two);
    expect(one[0]).toBe("a");
  });
});
