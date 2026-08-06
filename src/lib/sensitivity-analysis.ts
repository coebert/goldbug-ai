// Sensitivity analysis: how do drawdown and net CAGR respond when we move the
// risk dial and the cash-allocation target?
//
// Both knobs are set by hand today, and their interaction is not obvious: a
// higher invested target lifts CAGR right up until the drawdown halt starts
// firing, at which point extra exposure buys nothing but whipsaw. This module
// sweeps the two axes over one tape and reports the grid, the per-axis
// marginals and elasticities, and the best configuration that still respects a
// drawdown budget.
//
// The default scenario model is a deliberately simple, fully deterministic
// exposure simulation (no RNG, no I/O) so the report is reproducible. Callers
// with a real backtest can inject their own `evaluate` and keep the reporting.

import { RISK_PRESETS, riskPresetConfig, riskPresetName } from "./risk-presets";

export type SensitivityScenario = {
  /** 1..5 risk dial position. */
  riskLevel: number;
  /** Target invested share of NAV, 0..1 (cash target = 1 − this). */
  investedTarget: number;
};

export type ScenarioMetrics = {
  netCagrPct: number;
  maxDrawdownPct: number; // <= 0
  volatilityPct: number;
  sharpe: number;
  /** Mean realised exposure over the tape, 0..1. */
  avgExposure: number;
  /** Bars spent flat because the drawdown halt fired. */
  haltedBars: number;
  /** Total cost drag over the tape, in % of starting equity. */
  feeDragPct: number;
};

export type SensitivityCell = SensitivityScenario & {
  cashTarget: number;
  riskName: string;
  metrics: ScenarioMetrics;
  /** true when the cell's drawdown is inside the budget. */
  withinBudget: boolean;
};

// ---------------------------------------------------------------------------
// Default scenario model
// ---------------------------------------------------------------------------

export type SimulationOptions = {
  /** Bars per year in the supplied return series. */
  barsPerYear: number;
  /** Round-trip cost charged per year on the invested share, in %. */
  annualCostPct: number;
  /** Annual yield earned on the uninvested (cash) share, in %. */
  cashYieldPct: number;
  /** Bars the book stays flat after a drawdown halt fires. */
  haltBars: number;
  /** Hard ceiling on exposure — 1 means no leverage. */
  maxExposure: number;
};

export const DEFAULT_SIMULATION_OPTIONS: SimulationOptions = {
  barsPerYear: 252,
  annualCostPct: 1.2,
  cashYieldPct: 3,
  haltBars: 10,
  maxExposure: 1,
};

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function stdDev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / (xs.length - 1));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Deterministic exposure model.
 *
 * Exposure starts at `investedTarget`, is scaled by the dial's size multiplier
 * and capped at `maxExposure`. When the running drawdown breaches the dial's
 * `max_drawdown_halt_pct` the book goes flat for `haltBars` bars — which is
 * exactly why more exposure eventually stops helping.
 */
export function simulateScenario(
  returns: readonly number[],
  scenario: SensitivityScenario,
  opts: Partial<SimulationOptions> = {},
): ScenarioMetrics {
  const o = { ...DEFAULT_SIMULATION_OPTIONS, ...opts };
  if (o.barsPerYear <= 0) throw new Error("simulateScenario: barsPerYear must be > 0");
  if (scenario.investedTarget < 0 || scenario.investedTarget > 1) {
    throw new Error("simulateScenario: investedTarget must be between 0 and 1");
  }
  const cfg = riskPresetConfig(scenario.riskLevel);
  const sizeMult = cfg.size_multiplier ?? 1;
  const haltAt = cfg.max_drawdown_halt_pct;
  const baseExposure = clamp(scenario.investedTarget * sizeMult, 0, o.maxExposure);

  const costPerBar = o.annualCostPct / 100 / o.barsPerYear;
  const cashPerBar = o.cashYieldPct / 100 / o.barsPerYear;

  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  let haltedBars = 0;
  let haltCooldown = 0;
  let costTotal = 0;
  const exposures: number[] = [];
  const barReturns: number[] = [];

  for (const r of returns) {
    const exposure = haltCooldown > 0 ? 0 : baseExposure;
    if (haltCooldown > 0) {
      haltCooldown--;
      haltedBars++;
    }
    exposures.push(exposure);

    const cost = exposure * costPerBar;
    costTotal += cost * equity;
    const barReturn = exposure * r + (1 - exposure) * cashPerBar - cost;
    barReturns.push(barReturn);
    equity *= 1 + barReturn;

    if (equity > peak) peak = equity;
    const dd = peak > 0 ? equity / peak - 1 : 0;
    if (dd < maxDd) maxDd = dd;
    if (haltCooldown === 0 && dd <= -haltAt) haltCooldown = o.haltBars;
  }

  const bars = returns.length;
  const years = bars > 0 ? bars / o.barsPerYear : 0;
  const netCagrPct = years > 0 && equity > 0 ? (Math.pow(equity, 1 / years) - 1) * 100 : 0;
  const sd = stdDev(barReturns);
  const volatilityPct = sd * Math.sqrt(o.barsPerYear) * 100;
  const sharpe = sd > 0 ? (mean(barReturns) * o.barsPerYear) / (sd * Math.sqrt(o.barsPerYear)) : 0;

  return {
    netCagrPct,
    maxDrawdownPct: maxDd * 100,
    volatilityPct,
    sharpe,
    avgExposure: mean(exposures),
    haltedBars,
    feeDragPct: costTotal * 100,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export const DEFAULT_RISK_LEVELS = Object.keys(RISK_PRESETS)
  .map(Number)
  .sort((a, b) => a - b);

export const DEFAULT_INVESTED_TARGETS = [0.3, 0.45, 0.6, 0.75, 0.9];

export type AxisMarginal = {
  /** Axis value (dial position, or invested target as a fraction). */
  value: number;
  label: string;
  cells: number;
  meanNetCagrPct: number;
  meanMaxDrawdownPct: number;
  worstMaxDrawdownPct: number;
  meanSharpe: number;
};

export type AxisSensitivity = {
  axis: "riskLevel" | "investedTarget";
  marginals: AxisMarginal[];
  /** OLS slope of net CAGR against the axis, per unit of the axis. */
  cagrSlope: number;
  /** OLS slope of max drawdown against the axis, per unit of the axis. */
  drawdownSlope: number;
  /** Spread of mean net CAGR across the axis, in percentage points. */
  cagrRange: number;
  /** Spread of mean max drawdown across the axis, in percentage points. */
  drawdownRange: number;
};

export type SensitivityReport = {
  cells: SensitivityCell[];
  riskLevels: number[];
  investedTargets: number[];
  /** Max acceptable drawdown, as a negative %. */
  drawdownBudgetPct: number;
  byRiskLevel: AxisSensitivity;
  byInvestedTarget: AxisSensitivity;
  /** Highest net CAGR overall, budget ignored. */
  bestCagr: SensitivityCell;
  /** Highest net CAGR among cells inside the drawdown budget. */
  bestWithinBudget: SensitivityCell | null;
  /** Shallowest drawdown overall. */
  safest: SensitivityCell;
  /** Which axis moves net CAGR more over the swept range. */
  dominantAxis: "riskLevel" | "investedTarget";
  /** Ordered largest-to-smallest CAGR range per axis, for a tornado chart. */
  tornado: Array<{ axis: "riskLevel" | "investedTarget"; cagrRange: number; drawdownRange: number }>;
  sentence: string;
};

function slope(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  return sxx > 0 ? sxy / sxx : 0;
}

function axisSensitivity(
  cells: readonly SensitivityCell[],
  axis: "riskLevel" | "investedTarget",
): AxisSensitivity {
  const values = [...new Set(cells.map((c) => c[axis]))].sort((a, b) => a - b);
  const marginals: AxisMarginal[] = values.map((value) => {
    const group = cells.filter((c) => c[axis] === value);
    return {
      value,
      label: axis === "riskLevel" ? riskPresetName(value) : `${Math.round(value * 100)}% invested`,
      cells: group.length,
      meanNetCagrPct: mean(group.map((c) => c.metrics.netCagrPct)),
      meanMaxDrawdownPct: mean(group.map((c) => c.metrics.maxDrawdownPct)),
      worstMaxDrawdownPct: Math.min(...group.map((c) => c.metrics.maxDrawdownPct)),
      meanSharpe: mean(group.map((c) => c.metrics.sharpe)),
    };
  });

  const xs = cells.map((c) => c[axis]);
  const range = (pick: (m: AxisMarginal) => number) => {
    const vs = marginals.map(pick);
    return vs.length ? Math.max(...vs) - Math.min(...vs) : 0;
  };

  return {
    axis,
    marginals,
    cagrSlope: slope(xs, cells.map((c) => c.metrics.netCagrPct)),
    drawdownSlope: slope(xs, cells.map((c) => c.metrics.maxDrawdownPct)),
    cagrRange: range((m) => m.meanNetCagrPct),
    drawdownRange: range((m) => m.meanMaxDrawdownPct),
  };
}

export type SensitivityOptions = Partial<SimulationOptions> & {
  riskLevels?: readonly number[];
  investedTargets?: readonly number[];
  /** Max tolerated drawdown as a positive % (default 20). */
  drawdownBudgetPct?: number;
  /** Swap in a real backtest instead of the built-in exposure model. */
  evaluate?: (scenario: SensitivityScenario) => ScenarioMetrics;
};

/**
 * Sweep the risk dial against the cash-allocation target and report how
 * drawdown and net CAGR respond.
 */
export function runSensitivityAnalysis(
  returns: readonly number[],
  opts: SensitivityOptions = {},
): SensitivityReport {
  const riskLevels = [...(opts.riskLevels ?? DEFAULT_RISK_LEVELS)].sort((a, b) => a - b);
  const investedTargets = [...(opts.investedTargets ?? DEFAULT_INVESTED_TARGETS)].sort(
    (a, b) => a - b,
  );
  if (!riskLevels.length || !investedTargets.length) {
    throw new Error("runSensitivityAnalysis: need at least one risk level and one invested target");
  }
  if (!opts.evaluate && returns.length < 2) {
    throw new Error("runSensitivityAnalysis: need at least two return bars");
  }
  const budget = -Math.abs(opts.drawdownBudgetPct ?? 20);

  const cells: SensitivityCell[] = [];
  for (const riskLevel of riskLevels) {
    for (const investedTarget of investedTargets) {
      const scenario = { riskLevel, investedTarget };
      const metrics = opts.evaluate
        ? opts.evaluate(scenario)
        : simulateScenario(returns, scenario, opts);
      cells.push({
        ...scenario,
        cashTarget: 1 - investedTarget,
        riskName: riskPresetName(riskLevel),
        metrics,
        withinBudget: metrics.maxDrawdownPct >= budget,
      });
    }
  }

  const byRiskLevel = axisSensitivity(cells, "riskLevel");
  const byInvestedTarget = axisSensitivity(cells, "investedTarget");

  const pickBest = (pool: readonly SensitivityCell[]) =>
    pool.reduce((best, c) =>
      c.metrics.netCagrPct > best.metrics.netCagrPct ? c : best,
    );
  const bestCagr = pickBest(cells);
  const inBudget = cells.filter((c) => c.withinBudget);
  const bestWithinBudget = inBudget.length ? pickBest(inBudget) : null;
  const safest = cells.reduce((best, c) =>
    c.metrics.maxDrawdownPct > best.metrics.maxDrawdownPct ? c : best,
  );

  // Normalise each axis's influence onto a comparable scale: the risk dial
  // moves in whole steps, the invested target in fractions.
  const dominantAxis =
    byRiskLevel.cagrRange >= byInvestedTarget.cagrRange ? "riskLevel" : "investedTarget";
  const tornado = [byRiskLevel, byInvestedTarget]
    .map((a) => ({ axis: a.axis, cagrRange: a.cagrRange, drawdownRange: a.drawdownRange }))
    .sort((a, b) => b.cagrRange - a.cagrRange);

  const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const sentence = bestWithinBudget
    ? `Best inside a ${Math.abs(budget).toFixed(0)}% drawdown budget: dial ${bestWithinBudget.riskLevel} (${bestWithinBudget.riskName}) at ${Math.round(bestWithinBudget.investedTarget * 100)}% invested — ${fmt(bestWithinBudget.metrics.netCagrPct)} net CAGR with a ${bestWithinBudget.metrics.maxDrawdownPct.toFixed(1)}% worst drawdown. ${dominantAxis === "riskLevel" ? "The risk dial" : "The cash target"} moves CAGR most across the sweep.`
    : `No configuration stayed inside the ${Math.abs(budget).toFixed(0)}% drawdown budget; the shallowest was dial ${safest.riskLevel} at ${Math.round(safest.investedTarget * 100)}% invested (${safest.metrics.maxDrawdownPct.toFixed(1)}%).`;

  return {
    cells,
    riskLevels,
    investedTargets,
    drawdownBudgetPct: budget,
    byRiskLevel,
    byInvestedTarget,
    bestCagr,
    bestWithinBudget,
    safest,
    dominantAxis,
    tornado,
    sentence,
  };
}

/** Grid view for a heatmap: rows are risk levels, columns invested targets. */
export function sensitivityGrid(
  report: SensitivityReport,
  metric: "netCagrPct" | "maxDrawdownPct" | "sharpe" = "netCagrPct",
): Array<{ riskLevel: number; riskName: string; values: Array<{ investedTarget: number; value: number }> }> {
  return report.riskLevels.map((riskLevel) => ({
    riskLevel,
    riskName: riskPresetName(riskLevel),
    values: report.investedTargets.map((investedTarget) => {
      const cell = report.cells.find(
        (c) => c.riskLevel === riskLevel && c.investedTarget === investedTarget,
      );
      return { investedTarget, value: cell ? cell.metrics[metric] : 0 };
    }),
  }));
}
