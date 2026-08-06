// Collapse a candidate's per-cost-scenario results into the single set of
// metrics the parameter optimiser ranks on.
//
// The optimiser used to evaluate every candidate against one hard-coded
// friction model, so a configuration that only worked at 5bps slippage and a
// £3 minimum fee looked exactly as good as one that survived 20bps and £8.
// With the slippage / min-fee / liquidity axes from the cost sweep available,
// each candidate can be run across the whole cost grid and scored on how it
// holds up — not on its luckiest scenario.
//
// Aggregation rules (deliberately asymmetric):
//   * return-like metrics (CAGR, total return, Sharpe) follow the chosen
//     `CostScoreMode` — mean, worst case, or the mean of the worst tail (CVaR);
//   * risk-like metrics (drawdown, turnover, fee drag) are ALWAYS worst case,
//     because a config that blows the drawdown cap in any cost world is not
//     one we want to ship;
//   * the audit is merged pessimistically, so borrowing or shorting in a
//     single scenario disqualifies the candidate everywhere.
//
// Pure and side-effect free: no tape, no network, no simulator.

import type { CandidateMetrics } from "./param-optimizer";
import type { CostScenario } from "./cost-sweep";
import { slippageBpsOf } from "./cost-sweep";

export type ScenarioRun = {
  /** Stable scenario identity, e.g. `scenarioKey(sc)` or its label. */
  scenario: string;
  /** Human label for reporting. Defaults to `scenario`. */
  label?: string;
  /** Cost multiplier the scenario was built at, when known. */
  scale?: number;
  /** Optional relative weight for `mode: "weighted"`. Default 1. */
  weight?: number;
  metrics: CandidateMetrics;
};

/**
 * How return-like metrics collapse across the cost grid.
 *  - `mean`      average across scenarios (each cost world equally likely)
 *  - `worst`     the single worst scenario (maximally conservative)
 *  - `cvar`      mean of the worst `tailShare` of scenarios (default 1/3)
 *  - `weighted`  weighted mean using each run's `weight`
 */
export type CostScoreMode = "mean" | "worst" | "cvar" | "weighted";

export type CostAggregationOptions = {
  mode?: CostScoreMode;
  /** Worst-tail fraction used by `cvar`. Default 1/3, clamped to [0,1]. */
  tailShare?: number;
};

export type CostRobustness = {
  scenarios: number;
  meanCagrPct: number;
  worstCagrPct: number;
  bestCagrPct: number;
  /** best − worst, in percentage points: how cost-sensitive the config is. */
  cagrSpreadPct: number;
  worstScenario: string;
  bestScenario: string;
  worstDrawdownPct: number;
  worstTradesPerYear: number;
  worstFeeDragPct: number;
  /** Share of scenarios with net CAGR at or above `minCagrPct`. */
  profitableShare: number;
  /**
   * Slope of net CAGR against total per-side cost in bps, when the runs carry
   * enough distinct cost levels to fit one. Negative = costs bite.
   */
  cagrPerCostBps: number | null;
};

const isNum = (v: number) => Number.isFinite(v);

function assertRuns(runs: readonly ScenarioRun[], fn: string): void {
  if (runs.length === 0) throw new Error(`${fn}: no scenario runs`);
}

/** Mean of a numeric projection. */
function mean(runs: readonly ScenarioRun[], f: (m: CandidateMetrics) => number): number {
  return runs.reduce((a, r) => a + f(r.metrics), 0) / runs.length;
}

function weightedMean(runs: readonly ScenarioRun[], f: (m: CandidateMetrics) => number): number {
  let wsum = 0;
  let acc = 0;
  for (const r of runs) {
    const w = r.weight === undefined ? 1 : r.weight;
    if (!isNum(w) || w < 0) throw new Error(`aggregateScenarioMetrics: invalid weight ${r.weight}`);
    wsum += w;
    acc += w * f(r.metrics);
  }
  if (wsum <= 0) throw new Error("aggregateScenarioMetrics: weights sum to zero");
  return acc / wsum;
}

/** Mean over the worst `tailShare` of runs, ordered by net CAGR ascending. */
function tailMean(
  runs: readonly ScenarioRun[],
  f: (m: CandidateMetrics) => number,
  tailShare: number,
): number {
  const sorted = [...runs].sort((a, b) => a.metrics.cagrPct - b.metrics.cagrPct);
  const share = Math.min(1, Math.max(0, tailShare));
  const k = Math.max(1, Math.ceil(sorted.length * share));
  const tail = sorted.slice(0, k);
  return tail.reduce((a, r) => a + f(r.metrics), 0) / tail.length;
}

/**
 * Collapse per-scenario metrics into the single `CandidateMetrics` the
 * optimiser's constraint check and score consume.
 */
export function aggregateScenarioMetrics(
  runs: readonly ScenarioRun[],
  opts: CostAggregationOptions = {},
): CandidateMetrics {
  assertRuns(runs, "aggregateScenarioMetrics");
  const mode: CostScoreMode = opts.mode ?? "mean";
  const tailShare = opts.tailShare ?? 1 / 3;

  const ret = (f: (m: CandidateMetrics) => number): number => {
    switch (mode) {
      case "worst":
        return tailMean(runs, f, 0);
      case "cvar":
        return tailMean(runs, f, tailShare);
      case "weighted":
        return weightedMean(runs, f);
      case "mean":
      default:
        return mean(runs, f);
    }
  };

  const audits = runs.map((r) => r.metrics.audit).filter((a): a is NonNullable<typeof a> => !!a);
  const mergedAudit = audits.length
    ? {
        minCash: Math.min(...audits.map((a) => a.minCash)),
        minQuantity: Math.min(...audits.map((a) => a.minQuantity)),
        maxGrossExposurePct: Math.max(...audits.map((a) => a.maxGrossExposurePct)),
        rejections: audits.reduce<Record<string, number>>((acc, a) => {
          for (const [k, v] of Object.entries(a.rejections)) acc[k] = (acc[k] ?? 0) + v;
          return acc;
        }, {}),
        clean: audits.every((a) => a.clean),
      }
    : undefined;

  return {
    cagrPct: ret((m) => m.cagrPct),
    totalReturnPct: ret((m) => m.totalReturnPct),
    sharpe: ret((m) => m.sharpe),
    // Risk and cost metrics: always the worst cost world.
    maxDrawdownPct: -Math.max(...runs.map((r) => Math.abs(r.metrics.maxDrawdownPct))),
    tradesPerYear: Math.max(...runs.map((r) => r.metrics.tradesPerYear)),
    feeDragPct: Math.max(...runs.map((r) => r.metrics.feeDragPct)),
    // Trade count is a property of the policy, not the cost world.
    trades: mean(runs, (m) => m.trades),
    finalCashPct: Math.min(...runs.map((r) => r.metrics.finalCashPct)),
    ...(mergedAudit ? { audit: mergedAudit } : {}),
  };
}

/** Least-squares slope of y on x; null when x has no spread. */
function slope(points: ReadonlyArray<{ x: number; y: number }>): number | null {
  if (points.length < 2) return null;
  const mx = points.reduce((a, p) => a + p.x, 0) / points.length;
  const my = points.reduce((a, p) => a + p.y, 0) / points.length;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  if (den <= 1e-12) return null;
  return Number((num / den).toFixed(10));
}

/**
 * Total per-side proportional cost implied by a scenario, in bps. Used as the
 * x-axis for the cost-sensitivity slope. Liquidity scenarios price per fill,
 * so they contribute their cost scale rather than a flat bps figure.
 */
export function scenarioCostBps(sc: CostScenario): number {
  const commission = sc.frictions.commissionBps ?? 0;
  const tax = sc.frictions.buyTaxBps ?? 0;
  const slip = sc.slippage
    ? slippageBpsOf(sc.slippage)
    : (sc.frictions.slippageBps ?? 0);
  return Number((commission + tax + slip).toFixed(6));
}

export type RobustnessOptions = {
  /** Net CAGR a scenario must clear to count as profitable. Default 0. */
  minCagrPct?: number;
  /** Total per-side cost (bps) per scenario id, for the sensitivity slope. */
  costBpsByScenario?: Readonly<Record<string, number>>;
};

/** How a candidate holds up across the cost grid. */
export function costRobustness(
  runs: readonly ScenarioRun[],
  opts: RobustnessOptions = {},
): CostRobustness {
  assertRuns(runs, "costRobustness");
  const minCagrPct = opts.minCagrPct ?? 0;
  const sorted = [...runs].sort((a, b) => a.metrics.cagrPct - b.metrics.cagrPct);
  const worst = sorted[0]!;
  const best = sorted[sorted.length - 1]!;
  const costs = opts.costBpsByScenario;
  const points = costs
    ? runs
        .filter((r) => isNum(costs[r.scenario] ?? NaN))
        .map((r) => ({ x: costs[r.scenario]!, y: r.metrics.cagrPct }))
    : runs
        .filter((r) => r.scale !== undefined && isNum(r.scale))
        .map((r) => ({ x: r.scale!, y: r.metrics.cagrPct }));

  return {
    scenarios: runs.length,
    meanCagrPct: mean(runs, (m) => m.cagrPct),
    worstCagrPct: worst.metrics.cagrPct,
    bestCagrPct: best.metrics.cagrPct,
    cagrSpreadPct: Number((best.metrics.cagrPct - worst.metrics.cagrPct).toFixed(10)),
    worstScenario: worst.label ?? worst.scenario,
    bestScenario: best.label ?? best.scenario,
    worstDrawdownPct: -Math.max(...runs.map((r) => Math.abs(r.metrics.maxDrawdownPct))),
    worstTradesPerYear: Math.max(...runs.map((r) => r.metrics.tradesPerYear)),
    worstFeeDragPct: Math.max(...runs.map((r) => r.metrics.feeDragPct)),
    profitableShare:
      runs.filter((r) => r.metrics.cagrPct >= minCagrPct - 1e-12).length / runs.length,
    cagrPerCostBps: slope(points),
  };
}

/** One-line CLI summary of a candidate's cost robustness. */
export function describeRobustness(r: CostRobustness): string {
  const slopeTxt =
    r.cagrPerCostBps === null
      ? "flat cost axis"
      : `${r.cagrPerCostBps >= 0 ? "+" : ""}${r.cagrPerCostBps.toFixed(3)}pp per cost unit`;
  return (
    `${r.scenarios} scenarios · worst ${r.worstCagrPct.toFixed(2)}% (${r.worstScenario}) · ` +
    `mean ${r.meanCagrPct.toFixed(2)}% · spread ${r.cagrSpreadPct.toFixed(2)}pp · ` +
    `${(r.profitableShare * 100).toFixed(0)}% of cost worlds profitable · ${slopeTxt}`
  );
}

/** Label for the aggregation mode, for report headers. */
export function describeCostScoreMode(mode: CostScoreMode, tailShare = 1 / 3): string {
  switch (mode) {
    case "worst":
      return "worst-case cost scenario";
    case "cvar":
      return `mean of worst ${(Math.min(1, Math.max(0, tailShare)) * 100).toFixed(0)}% of cost scenarios`;
    case "weighted":
      return "weighted mean across cost scenarios";
    case "mean":
    default:
      return "mean across cost scenarios";
  }
}
