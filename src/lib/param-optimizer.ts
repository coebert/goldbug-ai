/**
 * Constrained parameter optimisation for the trading rules.
 *
 * Objective: maximise **net CAGR** (already net of commission, slippage,
 * impact and taxes — the backtest equity curve is post-fee).
 *
 * Subject to:
 *  - a turnover ceiling (round-trips per year), so the optimiser cannot buy
 *    performance with churn the live engine would never sustain;
 *  - an optional drawdown ceiling and a minimum trade count (a config that
 *    trades three times has no statistical claim to its CAGR);
 *  - hard no-leverage / no-borrow / no-short invariants, taken from the
 *    simulator audit. A candidate that breaches these is disqualified
 *    outright, never merely penalised.
 *
 * Everything here is pure and deterministic: the same space, seed and
 * evaluations always produce the same ranking. The expensive part — actually
 * running tapes — is injected by the caller.
 */
import type { RiskConfig } from "./universe.server";
import type { RunAudit } from "./trading-style-backtest";

export type ParamValue = number | boolean;

/** One tunable axis and the discrete levels the optimiser may try. */
export type ParamAxis = {
  /** RiskConfig field name, or one of the sleeve keys below. */
  key: string;
  label?: string;
  values: readonly ParamValue[];
};

export type ParamSet = Record<string, ParamValue>;

/** Sleeve keys are not RiskConfig fields; they size the entry ticket. */
export const SLEEVE_KEYS = ["max_names", "per_name_weight"] as const;
export type SleeveKey = (typeof SLEEVE_KEYS)[number];

export type Sleeve = { maxNames: number; perNameWeight: number };

/** Split a param set into a RiskConfig patch and a sleeve. */
export function applyParams(
  base: RiskConfig,
  baseSleeve: Sleeve,
  params: ParamSet,
): { cfg: RiskConfig; sleeve: Sleeve } {
  const cfg = { ...base } as RiskConfig & Record<string, ParamValue>;
  const sleeve: Sleeve = { ...baseSleeve };
  for (const [key, value] of Object.entries(params)) {
    if (key === "max_names") {
      sleeve.maxNames = Math.max(1, Math.round(Number(value)));
      continue;
    }
    if (key === "per_name_weight") {
      sleeve.perNameWeight = Number(value);
      continue;
    }
    if (!(key in base)) throw new Error(`applyParams: unknown parameter "${key}"`);
    cfg[key] = value;
  }
  // No-leverage guard at the *space* level: the sleeve can never ask for more
  // than 100% of equity, whatever the optimiser proposes.
  if (sleeve.maxNames * sleeve.perNameWeight > 1) {
    sleeve.perNameWeight = Number((1 / sleeve.maxNames).toFixed(6));
  }
  return { cfg: cfg as RiskConfig, sleeve };
}

/** Full cartesian product, in stable axis order. */
export function enumerateGrid(axes: readonly ParamAxis[]): ParamSet[] {
  let out: ParamSet[] = [{}];
  for (const axis of axes) {
    if (axis.values.length === 0) throw new Error(`axis "${axis.key}" has no values`);
    const next: ParamSet[] = [];
    for (const partial of out) {
      for (const v of axis.values) next.push({ ...partial, [axis.key]: v });
    }
    out = next;
  }
  return out;
}

/** Deterministic 32-bit LCG — same seed, same sample, forever. */
function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Deterministic random subset of the grid. Used when the full product is too
 * large to run; sampling beats truncating because truncation only ever
 * explores the first axis's early levels.
 */
export function sampleGrid(axes: readonly ParamAxis[], limit: number, seed = 20260806): ParamSet[] {
  const all = enumerateGrid(axes);
  if (all.length <= limit) return all;
  const rnd = lcg(seed);
  const idx = all.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx
    .slice(0, limit)
    .sort((a, b) => a - b)
    .map((i) => all[i]!);
}

/** Metrics the optimiser needs from one evaluated candidate. */
export type CandidateMetrics = {
  cagrPct: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  trades: number;
  tradesPerYear: number;
  feeDragPct: number;
  finalCashPct: number;
  audit?: RunAudit;
};

export type OptimizerConstraints = {
  /** Turnover ceiling: round-trip legs per 252 bars. */
  maxTradesPerYear: number;
  /** Optional worst-case drawdown ceiling, as a positive % (e.g. 25 = -25%). */
  maxDrawdownPct?: number;
  /** Reject configs with too few trades to be statistically meaningful. */
  minTrades?: number;
  /** Enforce the simulator audit (no borrow, no short, no leverage). Default true. */
  enforceNoLeverage?: boolean;
};

export type ConstraintCheck = { feasible: boolean; violations: string[]; disqualified: boolean };

/**
 * Constraint evaluation. Turnover/drawdown breaches make a candidate
 * infeasible (ranked below every feasible one, but still reported so the
 * frontier is visible). Leverage/borrow/short breaches *disqualify* it — a
 * config that borrows is not a slower version of a good config, it is invalid.
 */
export function evaluateConstraints(
  m: CandidateMetrics,
  c: OptimizerConstraints,
): ConstraintCheck {
  const violations: string[] = [];
  let disqualified = false;

  if (m.tradesPerYear > c.maxTradesPerYear + 1e-9) {
    violations.push(
      `turnover ${m.tradesPerYear.toFixed(0)}/yr > ${c.maxTradesPerYear.toFixed(0)}/yr`,
    );
  }
  if (c.maxDrawdownPct !== undefined && Math.abs(m.maxDrawdownPct) > c.maxDrawdownPct + 1e-9) {
    violations.push(
      `drawdown ${Math.abs(m.maxDrawdownPct).toFixed(1)}% > ${c.maxDrawdownPct.toFixed(1)}%`,
    );
  }
  if (c.minTrades !== undefined && m.trades < c.minTrades) {
    violations.push(`only ${m.trades} trades (< ${c.minTrades})`);
  }
  if (c.enforceNoLeverage !== false && m.audit) {
    if (m.audit.minCash < -1e-6) {
      violations.push(`borrowed cash (min ${m.audit.minCash.toFixed(2)})`);
      disqualified = true;
    }
    if (m.audit.minQuantity < -1e-9) {
      violations.push(`short position (min qty ${m.audit.minQuantity})`);
      disqualified = true;
    }
    if (m.audit.maxGrossExposurePct > 100 + 1e-6) {
      violations.push(`levered to ${m.audit.maxGrossExposurePct.toFixed(1)}% of equity`);
      disqualified = true;
    }
  }
  return { feasible: violations.length === 0, violations, disqualified };
}

export type OptimizerResult = {
  params: ParamSet;
  metrics: CandidateMetrics;
  check: ConstraintCheck;
  /** Objective actually used for ranking. */
  score: number;
};

/**
 * Ranking score: net CAGR for feasible candidates; a penalised value for
 * infeasible ones so they always sort below any feasible candidate but still
 * order sensibly among themselves. Disqualified candidates score -Infinity.
 */
export function scoreCandidate(m: CandidateMetrics, check: ConstraintCheck): number {
  if (check.disqualified) return Number.NEGATIVE_INFINITY;
  if (check.feasible) return m.cagrPct;
  // Push below the feasible band without collapsing the ordering.
  return -1e6 + m.cagrPct - 100 * check.violations.length;
}

export function scoreAll(
  evaluated: ReadonlyArray<{ params: ParamSet; metrics: CandidateMetrics }>,
  constraints: OptimizerConstraints,
): OptimizerResult[] {
  return evaluated.map(({ params, metrics }) => {
    const check = evaluateConstraints(metrics, constraints);
    return { params, metrics, check, score: scoreCandidate(metrics, check) };
  });
}

/** Highest score first; ties broken by lower turnover, then lower drawdown. */
export function rankResults(results: readonly OptimizerResult[]): OptimizerResult[] {
  return [...results].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.metrics.tradesPerYear !== b.metrics.tradesPerYear) {
      return a.metrics.tradesPerYear - b.metrics.tradesPerYear;
    }
    return Math.abs(a.metrics.maxDrawdownPct) - Math.abs(b.metrics.maxDrawdownPct);
  });
}

/** Best feasible candidate, or null when nothing clears the constraints. */
export function bestFeasible(results: readonly OptimizerResult[]): OptimizerResult | null {
  return rankResults(results.filter((r) => r.check.feasible))[0] ?? null;
}

/**
 * Pareto frontier on (net CAGR ↑, turnover ↓) over non-disqualified
 * candidates: the honest trade-off curve behind the single winner.
 */
export function paretoFrontier(results: readonly OptimizerResult[]): OptimizerResult[] {
  const pool = results.filter((r) => !r.check.disqualified);
  const front = pool.filter(
    (r) =>
      !pool.some(
        (o) =>
          o !== r &&
          o.metrics.cagrPct >= r.metrics.cagrPct &&
          o.metrics.tradesPerYear <= r.metrics.tradesPerYear &&
          (o.metrics.cagrPct > r.metrics.cagrPct ||
            o.metrics.tradesPerYear < r.metrics.tradesPerYear),
      ),
  );
  return front.sort((a, b) => a.metrics.tradesPerYear - b.metrics.tradesPerYear);
}

export type AxisImpact = {
  key: string;
  levels: Array<{ value: ParamValue; meanCagrPct: number; feasible: number; total: number }>;
  /** Level with the highest mean CAGR among evaluated cells. */
  bestValue: ParamValue | null;
  /** Spread between the best and worst level's mean CAGR. */
  spreadPct: number;
};

/**
 * Marginal effect of one axis: mean net CAGR at each level, over candidates
 * that were not disqualified. A near-zero spread means the axis does not
 * matter and can be frozen — the most useful output of a sweep.
 */
export function axisImpact(results: readonly OptimizerResult[], key: string): AxisImpact {
  const pool = results.filter((r) => !r.check.disqualified && key in r.params);
  const byValue = new Map<ParamValue, OptimizerResult[]>();
  for (const r of pool) {
    const v = r.params[key]!;
    byValue.set(v, [...(byValue.get(v) ?? []), r]);
  }
  const levels = [...byValue.entries()]
    .map(([value, rs]) => ({
      value,
      meanCagrPct: rs.reduce((a, r) => a + r.metrics.cagrPct, 0) / rs.length,
      feasible: rs.filter((r) => r.check.feasible).length,
      total: rs.length,
    }))
    .sort((a, b) => Number(a.value) - Number(b.value));
  if (levels.length === 0) return { key, levels, bestValue: null, spreadPct: 0 };
  const best = levels.reduce((a, b) => (b.meanCagrPct > a.meanCagrPct ? b : a));
  const worst = levels.reduce((a, b) => (b.meanCagrPct < a.meanCagrPct ? b : a));
  return {
    key,
    levels,
    bestValue: best.value,
    spreadPct: best.meanCagrPct - worst.meanCagrPct,
  };
}

/**
 * Average one candidate's metrics across folds/seeds. Optimising on a single
 * tape is curve fitting; the mean across folds is what should be ranked.
 * The audit is merged conservatively: any dirty fold makes the whole thing
 * dirty.
 */
export function averageMetrics(runs: readonly CandidateMetrics[]): CandidateMetrics {
  if (runs.length === 0) throw new Error("averageMetrics: no runs");
  const avg = (f: (m: CandidateMetrics) => number) =>
    runs.reduce((a, m) => a + f(m), 0) / runs.length;
  const audits = runs.map((r) => r.audit).filter((a): a is RunAudit => !!a);
  const mergedAudit: RunAudit | undefined = audits.length
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
    cagrPct: avg((m) => m.cagrPct),
    totalReturnPct: avg((m) => m.totalReturnPct),
    maxDrawdownPct: avg((m) => m.maxDrawdownPct),
    sharpe: avg((m) => m.sharpe),
    trades: avg((m) => m.trades),
    tradesPerYear: avg((m) => m.tradesPerYear),
    feeDragPct: avg((m) => m.feeDragPct),
    finalCashPct: avg((m) => m.finalCashPct),
    ...(mergedAudit ? { audit: mergedAudit } : {}),
  };
}

/** Compact param set rendering, e.g. `stop_loss_pct=0.08 max_names=6`. */
export function formatParams(params: ParamSet): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${typeof v === "number" ? Number(v.toFixed(4)) : v}`)
    .join(" ");
}

/** One-line summary of a ranked candidate for CLI output. */
export function formatResult(r: OptimizerResult): string {
  const status = r.check.disqualified
    ? "DISQUALIFIED"
    : r.check.feasible
      ? "ok"
      : `infeasible (${r.check.violations.join("; ")})`;
  return (
    `CAGR ${r.metrics.cagrPct.toFixed(2).padStart(6)}%  ` +
    `DD ${Math.abs(r.metrics.maxDrawdownPct).toFixed(1).padStart(5)}%  ` +
    `turnover ${r.metrics.tradesPerYear.toFixed(0).padStart(4)}/yr  ` +
    `fees ${r.metrics.feeDragPct.toFixed(1).padStart(5)}%  ` +
    `${status}  ${formatParams(r.params)}`
  );
}
