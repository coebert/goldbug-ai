/**
 * Integration: the parameter optimiser driven end to end under the fee-drag
 * objective.
 *
 * Unlike the unit tests, nothing here hand-writes a `CandidateMetrics`. A tiny
 * deterministic cost tape turns each grid cell into fills, those fills go
 * through the real `estimateFeeDrag`, and the resulting metrics go through the
 * real `scoreAll` / `rankResults` / `compareObjectives` pipeline. The two
 * properties under test are the ones the objective's docstring promises:
 *
 *  1. the drawdown ceiling is a HARD constraint — no λ, however large, can
 *     buy a cheaper config past it, and no fee saving can promote a
 *     risk-breaching candidate into the winner's seat;
 *  2. fee drag genuinely moves the ranking — raising λ shifts the winner
 *     toward fewer, larger, longer-held tickets that pay less drag.
 */
import { describe, expect, it } from "vitest";
import type { RiskConfig } from "@/lib/universe.server";
import type { RunAudit } from "@/lib/trading-style-backtest";
import {
  estimateFeeDrag,
  totalFeeDragPct,
  type FeeDragFill,
  type FeeDragFrictions,
  type FeeDragObjective,
  NET_CAGR_OBJECTIVE,
} from "@/lib/fee-drag-objective";
import {
  annualFeeDrag,
  applyParams,
  bestFeasible,
  compareObjectives,
  enumerateGrid,
  evaluateConstraints,
  feeParetoFrontier,
  formatResult,
  rankResults,
  scoreAll,
  type CandidateMetrics,
  type OptimizerConstraints,
  type ParamAxis,
  type ParamSet,
  type Sleeve,
} from "@/lib/param-optimizer";

// --------------------------------------------------------------------------
// A deterministic mini-tape: no randomness, no dates, no I/O.

const STARTING_CASH = 10_000;
const YEARS = 5;

const FRICTIONS: FeeDragFrictions = {
  commissionBps: 10,
  minCommission: 8, // Saxo-style per-ticket floor: what punishes small tickets
  slippageBps: 8,
  buyTaxBps: 50, // UK stamp duty on buys
};

/** Fixed base config; the swept keys are the sleeve pair plus `hold_days`. */
const BASE_CFG = { max_position_pct: 20, hold_days: 20 } as unknown as RiskConfig;
const BASE_SLEEVE: Sleeve = { maxNames: 6, perNameWeight: 0.1 };

const CLEAN_AUDIT: RunAudit = {
  minCash: 12.5,
  minQuantity: 0,
  maxGrossExposurePct: 96,
  rejections: {},
  clean: true,
};

/**
 * Turn one grid cell into a run.
 *
 * Gross alpha rises modestly as holds shorten (more shots on goal) and as the
 * book concentrates; drawdown rises with concentration. Costs are whatever the
 * resulting ticket schedule actually pays. Net CAGR is gross less realised
 * drag, so the equity curve is post-fee exactly like the real backtester's.
 */
function simulate(params: ParamSet): CandidateMetrics {
  const { sleeve } = applyParams(BASE_CFG, BASE_SLEEVE, params);
  const holdDays = Number(params["hold_days"]);
  const roundTripsPerName = Math.max(1, Math.round(252 / holdDays));
  const legs = sleeve.maxNames * roundTripsPerName * 2; // buy + sell
  const notional = STARTING_CASH * sleeve.perNameWeight;

  const fills: FeeDragFill[] = [];
  for (let i = 0; i < legs * YEARS; i++) {
    const side = i % 2 === 0 ? "BUY" : "SELL";
    const rate = notional * ((FRICTIONS.commissionBps ?? 0) / 10_000);
    const tax = side === "BUY" ? notional * ((FRICTIONS.buyTaxBps ?? 0) / 10_000) : 0;
    fills.push({
      notional,
      side,
      fee: Math.max(FRICTIONS.minCommission ?? 0, rate) + tax,
    });
  }

  const feeDrag = estimateFeeDrag(fills, FRICTIONS, STARTING_CASH);
  const annualDrag = totalFeeDragPct(feeDrag) / YEARS;

  // Gross: more concentration and more shots on goal earn more, with
  // diminishing returns; drawdown scales with single-name weight.
  const grossCagr = 6 + 40 * sleeve.perNameWeight + 60 / holdDays;
  const maxDrawdownPct = -(8 + 130 * sleeve.perNameWeight);

  const cagrPct = grossCagr - annualDrag;
  return {
    cagrPct,
    totalReturnPct: cagrPct * YEARS,
    maxDrawdownPct,
    sharpe: cagrPct / Math.abs(maxDrawdownPct),
    trades: fills.length,
    tradesPerYear: fills.length / YEARS,
    feeDragPct: feeDrag.commissionPct + feeDrag.otherPct,
    finalCashPct: 4,
    years: YEARS,
    feeDrag,
    audit: CLEAN_AUDIT,
  };
}

const AXES: readonly ParamAxis[] = [
  { key: "max_names", values: [3, 6, 10] },
  { key: "per_name_weight", values: [0.06, 0.12, 0.24] },
  { key: "hold_days", values: [3, 20, 60] },
];

const CONSTRAINTS: OptimizerConstraints = {
  maxTradesPerYear: 400,
  maxDrawdownPct: 25,
  minTrades: 10,
  enforceNoLeverage: true,
};

function sweep() {
  return enumerateGrid(AXES).map((params) => ({ params, metrics: simulate(params) }));
}

const objectiveWithLambda = (lambda: number): FeeDragObjective => ({
  kind: "fee_efficient_cagr",
  lambda,
});

describe("param optimizer under the fee-drag objective (integration)", () => {
  const evaluated = sweep();

  it("produces a mixed population: cheap, expensive, safe and risk-breaching", () => {
    expect(evaluated).toHaveLength(27);
    const drags = evaluated.map((e) => annualFeeDrag(e.metrics));
    expect(Math.min(...drags)).toBeGreaterThan(0);
    // The tape must actually separate configs on cost, otherwise the ranking
    // test below would pass vacuously.
    expect(Math.max(...drags)).toBeGreaterThan(Math.min(...drags) * 5);

    const dds = evaluated.map((e) => Math.abs(e.metrics.maxDrawdownPct));
    expect(Math.min(...dds)).toBeLessThan(CONSTRAINTS.maxDrawdownPct!);
    expect(Math.max(...dds)).toBeGreaterThan(CONSTRAINTS.maxDrawdownPct!);
  });

  it("keeps the drawdown ceiling hard for every λ", () => {
    for (const lambda of [0, 0.5, 1, 1.5, 3, 10]) {
      const results = scoreAll(evaluated, CONSTRAINTS, objectiveWithLambda(lambda));
      const winner = bestFeasible(results);
      expect(winner, `λ=${lambda} found no feasible config`).not.toBeNull();
      expect(
        Math.abs(winner!.metrics.maxDrawdownPct),
        `λ=${lambda}: ${formatResult(winner!)}`,
      ).toBeLessThanOrEqual(CONSTRAINTS.maxDrawdownPct!);

      // Every breaching candidate is infeasible and scored below the whole
      // feasible band — never merely "penalised into second place".
      const breaching = results.filter(
        (r) => Math.abs(r.metrics.maxDrawdownPct) > CONSTRAINTS.maxDrawdownPct!,
      );
      expect(breaching.length).toBeGreaterThan(0);
      for (const r of breaching) {
        expect(r.check.feasible).toBe(false);
        expect(r.check.violations.some((v) => v.startsWith("drawdown"))).toBe(true);
        expect(r.score).toBeLessThan(winner!.score);
      }
      // Nothing infeasible ever outranks a feasible candidate.
      const ranked = rankResults(results);
      const lastFeasible = ranked.reduce((acc, r, i) => (r.check.feasible ? i : acc), -1);
      const firstInfeasible = ranked.findIndex((r) => !r.check.feasible);
      expect(firstInfeasible).toBeGreaterThan(lastFeasible);
    }
  });

  it("cannot be bribed past the ceiling by a free, high-return config", () => {
    // The strongest possible temptation: best CAGR in the population, zero fee
    // drag, only flaw is a 40% drawdown.
    const bribe = {
      params: { max_names: 2, per_name_weight: 0.5, hold_days: 250 } as ParamSet,
      metrics: {
        ...simulate({ max_names: 3, per_name_weight: 0.24, hold_days: 60 }),
        cagrPct: 99,
        maxDrawdownPct: -40,
        feeDragPct: 0,
        feeDrag: { commissionPct: 0, minFeePct: 0, slippagePct: 0, otherPct: 0 },
      } satisfies CandidateMetrics,
    };
    const withBribe = [...evaluated, bribe];

    for (const lambda of [0, 1.5, 25]) {
      const objective = objectiveWithLambda(lambda);
      const ranked = rankResults(scoreAll(withBribe, CONSTRAINTS, objective));
      const winner = bestFeasible(scoreAll(withBribe, CONSTRAINTS, objective));
      expect(winner!.params).not.toEqual(bribe.params);
      expect(Math.abs(winner!.metrics.maxDrawdownPct)).toBeLessThanOrEqual(
        CONSTRAINTS.maxDrawdownPct!,
      );
      const bribeRow = ranked.find((r) => r.params === bribe.params)!;
      expect(bribeRow.check.feasible).toBe(false);
      expect(bribeRow.check.disqualified).toBe(false); // risk breach ≠ invalid run
      expect(ranked.indexOf(bribeRow)).toBeGreaterThan(ranked.indexOf(winner!));
    }
  });

  it("lets fee drag move the winner once λ is raised", () => {
    const cheapObjective = objectiveWithLambda(3);
    const rawWinner = bestFeasible(scoreAll(evaluated, CONSTRAINTS))!;
    const feeWinner = bestFeasible(scoreAll(evaluated, CONSTRAINTS, cheapObjective))!;

    expect(feeWinner.params).not.toEqual(rawWinner.params);
    // The fee-aware winner is strictly cheaper, and pays for it in raw CAGR.
    expect(annualFeeDrag(feeWinner.metrics)).toBeLessThan(annualFeeDrag(rawWinner.metrics));
    expect(feeWinner.metrics.cagrPct).toBeLessThanOrEqual(rawWinner.metrics.cagrPct);
    // Fewer, longer-held tickets: the shape the objective is meant to select.
    expect(feeWinner.metrics.tradesPerYear).toBeLessThan(rawWinner.metrics.tradesPerYear);
    expect(Number(feeWinner.params["hold_days"])).toBeGreaterThan(
      Number(rawWinner.params["hold_days"]),
    );

    const cmp = compareObjectives(evaluated, CONSTRAINTS, cheapObjective);
    expect(cmp.cagrWinner!.params).toEqual(rawWinner.params);
    expect(cmp.feeAwareWinner!.params).toEqual(feeWinner.params);
    expect(cmp.feeSavedPct).toBeGreaterThan(0);
    expect(cmp.objectiveGainPct).toBeGreaterThan(0);
    expect(cmp.cagrGivenUpPct).toBeGreaterThanOrEqual(0);
  });

  it("moves the winner monotonically toward cheaper configs as λ rises", () => {
    const drags = [0, 1, 2, 3, 6, 12].map((lambda) => {
      const winner = bestFeasible(scoreAll(evaluated, CONSTRAINTS, objectiveWithLambda(lambda)))!;
      return { lambda, drag: annualFeeDrag(winner.metrics), dd: Math.abs(winner.metrics.maxDrawdownPct) };
    });
    for (let i = 1; i < drags.length; i++) {
      expect(drags[i]!.drag, `λ=${drags[i]!.lambda}`).toBeLessThanOrEqual(drags[i - 1]!.drag + 1e-9);
      expect(drags[i]!.dd).toBeLessThanOrEqual(CONSTRAINTS.maxDrawdownPct!);
    }
    expect(drags.at(-1)!.drag).toBeLessThan(drags[0]!.drag);
  });

  it("treats the fee-drag ceiling as soft and the drawdown ceiling as hard", () => {
    const capped: FeeDragObjective = { kind: "fee_efficient_cagr", lambda: 1.5, maxAnnualFeeDragPct: 3 };
    const results = scoreAll(evaluated, CONSTRAINTS, capped);
    const overCap = results.filter((r) => annualFeeDrag(r.metrics) > 3 + 1e-9);
    expect(overCap.length).toBeGreaterThan(0);
    for (const r of overCap) {
      expect(r.check.feasible).toBe(false);
      expect(r.check.disqualified).toBe(false);
      expect(r.check.violations.some((v) => v.startsWith("fee drag"))).toBe(true);
    }
    // Same population, no fee ceiling: those rows come back as feasible, while
    // the drawdown breaches stay infeasible no matter what the objective says.
    const uncapped = scoreAll(evaluated, CONSTRAINTS, objectiveWithLambda(1.5));
    const recovered = uncapped.filter(
      (r) => annualFeeDrag(r.metrics) > 3 && r.check.feasible,
    );
    expect(recovered.length).toBeGreaterThan(0);
    for (const r of uncapped) {
      if (Math.abs(r.metrics.maxDrawdownPct) > CONSTRAINTS.maxDrawdownPct!) {
        expect(r.check.feasible).toBe(false);
      }
    }
  });

  it("disqualifies a levered run outright, unlike a risk-ceiling breach", () => {
    const levered: CandidateMetrics = {
      ...simulate({ max_names: 6, per_name_weight: 0.12, hold_days: 20 }),
      audit: { minCash: -250, minQuantity: -3, maxGrossExposurePct: 141, rejections: {}, clean: false },
    };
    const check = evaluateConstraints(levered, CONSTRAINTS, objectiveWithLambda(1.5));
    expect(check.disqualified).toBe(true);
    const ranked = rankResults(
      scoreAll([...evaluated, { params: { levered: 1 }, metrics: levered }], CONSTRAINTS, objectiveWithLambda(1.5)),
    );
    expect(ranked.at(-1)!.params).toEqual({ levered: 1 });
    expect(ranked.at(-1)!.score).toBe(Number.NEGATIVE_INFINITY);
    expect(feeParetoFrontier(ranked).some((r) => r.params["levered"] === 1)).toBe(false);
  });

  it("keeps the cost-of-return frontier inside the risk ceiling", () => {
    const results = scoreAll(evaluated, CONSTRAINTS, objectiveWithLambda(1.5));
    const frontier = feeParetoFrontier(results.filter((r) => r.check.feasible));
    expect(frontier.length).toBeGreaterThan(1);
    for (let i = 1; i < frontier.length; i++) {
      // Sorted cheapest-first, and each step up in cost buys more CAGR.
      expect(annualFeeDrag(frontier[i]!.metrics)).toBeGreaterThanOrEqual(
        annualFeeDrag(frontier[i - 1]!.metrics),
      );
      expect(frontier[i]!.metrics.cagrPct).toBeGreaterThan(frontier[i - 1]!.metrics.cagrPct);
    }
    for (const r of frontier) {
      expect(Math.abs(r.metrics.maxDrawdownPct)).toBeLessThanOrEqual(CONSTRAINTS.maxDrawdownPct!);
    }
  });

  it("is deterministic: the same sweep ranks identically every time", () => {
    const objective = objectiveWithLambda(1.5);
    const once = rankResults(scoreAll(sweep(), CONSTRAINTS, objective)).map(formatResult);
    const twice = rankResults(scoreAll(sweep(), CONSTRAINTS, objective)).map(formatResult);
    expect(twice).toEqual(once);
    expect(bestFeasible(scoreAll(sweep(), CONSTRAINTS, NET_CAGR_OBJECTIVE))!.params).toEqual(
      bestFeasible(scoreAll(sweep(), CONSTRAINTS, NET_CAGR_OBJECTIVE))!.params,
    );
  });
});
