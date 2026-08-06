// Stress-testing a chosen parameter set across a wider cost / slippage /
// commission grid.
//
// The sweep answers "which arm looks best?". This module answers the harder
// follow-up: "does that arm still respect my hard constraints — turnover and
// drawdown — in *every* cost scenario, not just the friendly ones?"
//
// Everything here is pure and deterministic so the verdicts can be unit
// tested without a tape, a broker, or the network.

import { cellScore, scenarioKey, type SweepCell } from "./cost-sweep";
import { cellRoundTripBps, gridWidth, rankRobustness, type RobustnessOptions, type RobustnessRow } from "./robustness-score";
import type { Frictions } from "./broker-simulator";

/**
 * A sweep cell plus the turnover information the constraint check needs.
 * `tradesPerYear` is preferred; when absent it is derived from `trades`
 * and the backtest length in years.
 */
export type StressCell = SweepCell & {
  tradesPerYear?: number;
  years?: number;
};

export type StressConstraints = {
  /** Hard ceiling on round-trip intensity (buys + sells per 252 bars). */
  maxTradesPerYear: number;
  /** Hard floor on drawdown, as a positive magnitude in % (20 = -20% allowed). */
  maxDrawdownPct: number;
  /** Minimum acceptable total return, in % (default 0). */
  minReturnPct?: number;
  /** Minimum acceptable Sharpe (default: unconstrained). */
  minSharpe?: number;
  /** Require the arm to beat its buy & hold benchmark (default false). */
  beatBenchmark?: boolean;
};

export const DEFAULT_STRESS_CONSTRAINTS: StressConstraints = {
  maxTradesPerYear: 60,
  maxDrawdownPct: 25,
  minReturnPct: 0,
  beatBenchmark: false,
};

export type ConstraintKey = "turnover" | "drawdown" | "return" | "sharpe" | "benchmark";

export type CellVerdict = {
  scenarioLabel: string;
  scenarioKey: string;
  scale: number;
  slippageLabel: string | null;
  minCommission: number | null;
  roundTripBps: number | null;
  returnPct: number;
  excessPct: number;
  sharpe: number;
  drawdownPct: number;
  turnover: number;
  pass: boolean;
  violations: ConstraintKey[];
};

/** Trades per year for a cell, from the explicit field or `trades / years`. */
export function cellTurnover(cell: StressCell, fallbackYears?: number): number {
  if (Number.isFinite(cell.tradesPerYear)) return Math.max(0, cell.tradesPerYear as number);
  const years = cell.years ?? fallbackYears;
  if (years && years > 0) return Math.max(0, cell.trades / years);
  return Math.max(0, cell.trades);
}

function resolve(c: StressConstraints): Required<Omit<StressConstraints, "minSharpe">> & {
  minSharpe: number | null;
} {
  if (!(c.maxTradesPerYear > 0)) throw new Error("maxTradesPerYear must be positive");
  if (!(c.maxDrawdownPct > 0)) throw new Error("maxDrawdownPct must be a positive magnitude");
  return {
    maxTradesPerYear: c.maxTradesPerYear,
    maxDrawdownPct: c.maxDrawdownPct,
    minReturnPct: c.minReturnPct ?? 0,
    beatBenchmark: c.beatBenchmark ?? false,
    minSharpe: c.minSharpe ?? null,
  };
}

export type CheckOptions = {
  baseFrictions?: Frictions;
  startingCash?: number;
  /** Backtest length used to derive turnover when a cell lacks it. */
  years?: number;
};

/** Evaluate one cost scenario against the constraint set. */
export function checkCell(
  cell: StressCell,
  constraints: StressConstraints,
  opts: CheckOptions = {},
): CellVerdict {
  const c = resolve(constraints);
  const turnover = cellTurnover(cell, opts.years);
  // Drawdowns are stored as negative percentages; compare magnitudes.
  const drawdownPct = -Math.abs(cell.maxDrawdownPct);
  const excessPct = cellScore(cell, "benchmark");
  const violations: ConstraintKey[] = [];
  if (turnover > c.maxTradesPerYear + 1e-9) violations.push("turnover");
  if (Math.abs(drawdownPct) > c.maxDrawdownPct + 1e-9) violations.push("drawdown");
  if (cell.totalReturnPct < c.minReturnPct - 1e-9) violations.push("return");
  if (c.minSharpe !== null && cell.sharpe < c.minSharpe - 1e-9) violations.push("sharpe");
  if (c.beatBenchmark && excessPct <= 0) violations.push("benchmark");

  return {
    scenarioLabel: cell.scenario.label,
    scenarioKey: scenarioKey(cell.scenario),
    scale: cell.scenario.scale,
    slippageLabel: cell.scenario.slippage?.label ?? null,
    minCommission: cell.scenario.minCommission ?? null,
    roundTripBps: cellRoundTripBps(cell, opts),
    returnPct: cell.totalReturnPct,
    excessPct,
    sharpe: cell.sharpe,
    drawdownPct,
    turnover,
    pass: violations.length === 0,
    violations,
  };
}

export type StressVerdict = "robust" | "conditional" | "fragile";

export type StressArmResult = {
  arm: string;
  style: string;
  riskLevel: string;
  ticketLabel: string;
  scenarios: CellVerdict[];
  scenarioCount: number;
  passCount: number;
  passRate: number;
  /** Constraint → how many scenarios it broke in. */
  bindingCounts: Record<ConstraintKey, number>;
  /** The constraint that broke most often, or null when nothing broke. */
  primaryBinding: ConstraintKey | null;
  worstReturnPct: number;
  worstDrawdownPct: number;
  peakTurnover: number;
  /** Highest modelled round-trip cost that still satisfies every constraint. */
  survivesToBps: number | null;
  /** Highest cost scale that still satisfies every constraint. */
  survivesToScale: number | null;
  verdict: StressVerdict;
};

const EMPTY_BINDINGS = (): Record<ConstraintKey, number> => ({
  turnover: 0,
  drawdown: 0,
  return: 0,
  sharpe: 0,
  benchmark: 0,
});

function armLabel(cell: SweepCell): string {
  return `${cell.riskLevel} · ${cell.style} · ${cell.ticket.label}`;
}

/** Group cells by (risk, style, ticket) — one arm per parameter set. */
export function groupArms(cells: readonly StressCell[]): Map<string, StressCell[]> {
  const out = new Map<string, StressCell[]>();
  for (const cell of cells) {
    const key = armLabel(cell);
    const bucket = out.get(key);
    if (bucket) bucket.push(cell);
    else out.set(key, [cell]);
  }
  return out;
}

export type StressOptions = CheckOptions & {
  /** passRate at or above which an arm is called "robust" (default 1). */
  robustAt?: number;
  /** passRate at or above which an arm is "conditional" (default 0.7). */
  conditionalAt?: number;
};

/** Run one parameter set through every cost scenario supplied for it. */
export function stressArm(
  cells: readonly StressCell[],
  constraints: StressConstraints,
  opts: StressOptions = {},
): StressArmResult {
  if (cells.length === 0) throw new Error("stressArm: no cells");
  const head = cells[0]!;
  const scenarios = cells
    .map((cell) => checkCell(cell, constraints, opts))
    .sort((a, b) => a.scale - b.scale || (a.roundTripBps ?? 0) - (b.roundTripBps ?? 0) || a.scenarioLabel.localeCompare(b.scenarioLabel));

  const bindingCounts = EMPTY_BINDINGS();
  for (const s of scenarios) for (const v of s.violations) bindingCounts[v] += 1;
  const primaryBinding =
    (Object.entries(bindingCounts) as [ConstraintKey, number][])
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

  const passing = scenarios.filter((s) => s.pass);
  const passRate = passing.length / scenarios.length;
  const robustAt = opts.robustAt ?? 1;
  const conditionalAt = opts.conditionalAt ?? 0.7;
  const verdict: StressVerdict =
    passRate >= robustAt - 1e-9 ? "robust" : passRate >= conditionalAt - 1e-9 ? "conditional" : "fragile";

  const bpsValues = passing.map((s) => s.roundTripBps).filter((b): b is number => b !== null);

  return {
    arm: armLabel(head),
    style: head.style,
    riskLevel: head.riskLevel,
    ticketLabel: head.ticket.label,
    scenarios,
    scenarioCount: scenarios.length,
    passCount: passing.length,
    passRate,
    bindingCounts,
    primaryBinding,
    worstReturnPct: Math.min(...scenarios.map((s) => s.returnPct)),
    worstDrawdownPct: Math.min(...scenarios.map((s) => s.drawdownPct)),
    peakTurnover: Math.max(...scenarios.map((s) => s.turnover)),
    survivesToBps: bpsValues.length ? Math.max(...bpsValues) : null,
    survivesToScale: passing.length ? Math.max(...passing.map((s) => s.scale)) : null,
    verdict,
  };
}

/** Stress every arm in the grid, hardest-hit last. */
export function stressGrid(
  cells: readonly StressCell[],
  constraints: StressConstraints,
  opts: StressOptions = {},
): StressArmResult[] {
  return [...groupArms(cells).values()]
    .map((group) => stressArm(group, constraints, opts))
    .sort(
      (a, b) =>
        b.passRate - a.passRate ||
        b.worstReturnPct - a.worstReturnPct ||
        a.arm.localeCompare(b.arm),
    );
}

export type BestFeasible = {
  arm: string;
  robustness: RobustnessRow;
  stress: StressArmResult;
  /** Arms that were feasible at baseline cost, in robustness order. */
  consideredArms: string[];
  /** Why this arm was picked, or why nothing was feasible. */
  reason: string;
};

/**
 * Pick the parameter set to stress: the highest-robustness arm that already
 * satisfies the constraints at (or below) baseline cost. Falls back to the
 * highest-robustness arm overall when nothing is feasible, so the caller
 * still gets a stress report rather than an empty one.
 */
export function selectBestFeasible(
  cells: readonly StressCell[],
  constraints: StressConstraints,
  opts: StressOptions & RobustnessOptions = {},
): BestFeasible | null {
  if (cells.length === 0) return null;
  const ranked = rankRobustness(cells, { ...opts, groupBy: "risk+style+ticket" });
  const arms = groupArms(cells);

  const feasible: string[] = [];
  for (const row of ranked) {
    const group = arms.get(row.arm);
    if (!group) continue;
    const baseline = group.filter((c) => c.scenario.scale <= 1 + 1e-9);
    if (baseline.length === 0) continue;
    const ok = baseline.every((c) => checkCell(c, constraints, opts).pass);
    if (ok) feasible.push(row.arm);
  }

  const chosenArm = feasible[0] ?? ranked[0]?.arm;
  if (!chosenArm) return null;
  const row = ranked.find((r) => r.arm === chosenArm)!;
  const group = arms.get(chosenArm)!;
  return {
    arm: chosenArm,
    robustness: row,
    stress: stressArm(group, constraints, opts),
    consideredArms: feasible,
    reason: feasible.length
      ? `best robustness (${row.score.toFixed(1)}, grade ${row.grade}) among ${feasible.length} arm(s) feasible at baseline cost`
      : `no arm satisfied the constraints at baseline cost; showing the highest-robustness arm (${row.score.toFixed(1)}, grade ${row.grade})`,
  };
}

// ---------------------------------------------------------------- output

export const STRESS_SCENARIO_COLUMNS = [
  "scenario",
  "round trip bps",
  "return %",
  "vs B&H %",
  "sharpe",
  "maxDD %",
  "trades/yr",
  "result",
] as const;

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "-");

export function scenarioTableRows(result: StressArmResult): string[][] {
  return result.scenarios.map((s) => [
    s.scenarioLabel,
    s.roundTripBps === null ? "-" : fmt(s.roundTripBps, 0),
    fmt(s.returnPct),
    fmt(s.excessPct),
    fmt(s.sharpe, 2),
    fmt(s.drawdownPct),
    fmt(s.turnover, 0),
    s.pass ? "pass" : `breach: ${s.violations.join(", ")}`,
  ]);
}

export const STRESS_ARM_COLUMNS = [
  "arm",
  "verdict",
  "pass rate",
  "binding",
  "worst return %",
  "worst maxDD %",
  "peak trades/yr",
  "survives to bps",
] as const;

export function armTableRows(results: readonly StressArmResult[]): string[][] {
  return results.map((r) => [
    r.arm,
    r.verdict,
    `${Math.round(r.passRate * 100)}%`,
    r.primaryBinding ?? "-",
    fmt(r.worstReturnPct),
    fmt(r.worstDrawdownPct),
    fmt(r.peakTurnover, 0),
    r.survivesToBps === null ? "-" : fmt(r.survivesToBps, 0),
  ]);
}

function pad(rows: readonly string[][], columns: readonly string[]): string {
  const all = [[...columns], ...rows];
  const widths = columns.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  return all
    .map((r) => r.map((cell, i) => (cell ?? "").padEnd(widths[i]!)).join("  "))
    .join("\n");
}

export function formatScenarioTable(result: StressArmResult): string {
  return pad(scenarioTableRows(result), STRESS_SCENARIO_COLUMNS);
}

export function formatArmTable(results: readonly StressArmResult[]): string {
  return pad(armTableRows(results), STRESS_ARM_COLUMNS);
}

/** One-line human verdict for a stressed arm. */
export function summariseStress(r: StressArmResult, constraints: StressConstraints): string {
  const c = resolve(constraints);
  const head =
    `${r.arm}: ${r.verdict} — ${r.passCount}/${r.scenarioCount} scenarios meet ` +
    `≤${c.maxTradesPerYear} trades/yr and ≥-${c.maxDrawdownPct}% drawdown`;
  const worst =
    ` (worst return ${fmt(r.worstReturnPct)}%, worst drawdown ${fmt(r.worstDrawdownPct)}%, ` +
    `peak turnover ${fmt(r.peakTurnover, 0)}/yr)`;
  const bind = r.primaryBinding ? `; binding constraint: ${r.primaryBinding}` : "";
  const survive =
    r.survivesToBps !== null ? `; holds to ~${fmt(r.survivesToBps, 0)}bps round trip` : "";
  return head + worst + bind + survive;
}

/** Grid width helper re-exported so report scripts need one import. */
export { gridWidth };
