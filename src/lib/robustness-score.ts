// Robustness scoring: collapse a full cost grid into one comparable number
// per trading rule / horizon, plus a ranking table.
//
// The sweep produces one cell per (risk × style × ticket × cost scenario).
// Reading that grid by eye is hopeless: a rule can look brilliant at zero
// cost and be worthless at baseline, or be mediocre everywhere but never
// blow up. A robustness score answers the question the grid is actually
// for — "which rule survives the widest range of cost assumptions?" —
// rather than "which rule won the single friendliest cell?".
//
// Deliberately pessimistic by construction:
//   * hit rates count *every* scenario, so cheap-cost wins cannot carry an
//     arm that dies at realistic costs;
//   * the worst cell in the grid is scored directly;
//   * sensitivity to cost is penalised, so a knife-edge edge ranks below a
//     flatter one with the same median.
//
// Pure and deterministic: no clock, no network, no database.

import {
  cellScore,
  roundTripCostBps,
  scenarioKey,
  seriesBaseFrictions,
  ticketValue,
  type SweepCell,
} from "./cost-sweep";
import type { Frictions } from "./broker-simulator";

/** How cells are collapsed into one comparable "arm". */
export type RobustnessGroupBy = "style" | "risk+style" | "risk+style+ticket" | "ticket";

export type RobustnessWeights = {
  /** Share of the grid with a positive net return. */
  profitHit: number;
  /** Share of the grid beating buy & hold. */
  benchmarkHit: number;
  /** Median net return across the grid. */
  medianReturn: number;
  /** Worst single cell in the grid (tail behaviour). */
  worstCase: number;
  /** Median Sharpe. */
  sharpe: number;
  /** Median max drawdown (penalty). */
  drawdown: number;
  /** Flatness of return vs round-trip cost (penalty for knife-edge edges). */
  costStability: number;
};

/**
 * Weights sum to 1. Hit rates dominate on purpose: consistency across the
 * grid is the property being measured, not peak return.
 */
export const DEFAULT_ROBUSTNESS_WEIGHTS: RobustnessWeights = {
  profitHit: 0.22,
  benchmarkHit: 0.22,
  medianReturn: 0.16,
  worstCase: 0.14,
  sharpe: 0.1,
  drawdown: 0.08,
  costStability: 0.08,
};

export type RobustnessComponents = {
  [K in keyof RobustnessWeights]: number;
};

export type RobustnessRow = {
  /** Group label, e.g. "balanced · swing · 5 x 18%". */
  arm: string;
  style: string;
  riskLevel: string;
  ticketLabel: string;
  /** Number of cost-grid cells behind this row. */
  cells: number;
  profitHitRate: number;
  benchmarkHitRate: number;
  medianReturnPct: number;
  worstReturnPct: number;
  bestReturnPct: number;
  medianSharpe: number;
  medianMaxDrawdownPct: number;
  medianTrades: number;
  /** Return lost per +10bps of modelled round-trip cost (negative = decays). */
  returnPerTenBps: number | null;
  /** Sub-scores in 0..1, before weighting. */
  components: RobustnessComponents;
  /** Weighted total, 0..100. */
  score: number;
  /** A → E band derived from the score. */
  grade: string;
};

// ------------------------------------------------------------- statistics

export function median(values: readonly number[]): number {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

/** Squash an unbounded metric into 0..1; `scale` is the "good" magnitude. */
export function squash(value: number, scale: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!(scale > 0)) throw new Error(`squash: scale must be > 0, got ${scale}`);
  return 0.5 * (1 + Math.tanh(value / scale));
}

/** Least-squares slope of y on x; null when x has no spread. */
export function slope(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    num += dx * (ys[i]! - my);
    den += dx * dx;
  }
  if (den <= 1e-12) return null;
  return num / den;
}

// ------------------------------------------------------------- grouping

export function armKey(cell: SweepCell, groupBy: RobustnessGroupBy): string {
  switch (groupBy) {
    case "style":
      return cell.style;
    case "ticket":
      return cell.ticket.label;
    case "risk+style":
      return `${cell.riskLevel} · ${cell.style}`;
    case "risk+style+ticket":
      return `${cell.riskLevel} · ${cell.style} · ${cell.ticket.label}`;
  }
}

export function groupCells(
  cells: readonly SweepCell[],
  groupBy: RobustnessGroupBy,
): Map<string, SweepCell[]> {
  const out = new Map<string, SweepCell[]>();
  for (const c of cells) {
    const key = armKey(c, groupBy);
    const bucket = out.get(key);
    if (bucket) bucket.push(c);
    else out.set(key, [c]);
  }
  return out;
}

/** A→E band. Anything below 40 has no reliable edge across the grid. */
export function gradeFor(score: number): string {
  if (score >= 75) return "A";
  if (score >= 60) return "B";
  if (score >= 45) return "C";
  if (score >= 30) return "D";
  return "E";
}

// --------------------------------------------------------------- scoring

export type RobustnessOptions = {
  groupBy?: RobustnessGroupBy;
  weights?: Partial<RobustnessWeights>;
  /**
   * Baseline friction model and account size. When supplied, each cell's
   * modelled round-trip cost in bps is computed so the score can penalise
   * arms whose return collapses as costs rise.
   */
  baseFrictions?: Frictions;
  startingCash?: number;
  /** Return magnitude treated as "good" when squashing, in % (default 20). */
  returnScale?: number;
};

function resolveWeights(partial?: Partial<RobustnessWeights>): RobustnessWeights {
  const w = { ...DEFAULT_ROBUSTNESS_WEIGHTS, ...(partial ?? {}) };
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  if (!(total > 0)) throw new Error("robustness weights must sum to a positive number");
  // Normalise so callers can pass partial overrides without re-balancing.
  return Object.fromEntries(
    Object.entries(w).map(([k, v]) => [k, v / total]),
  ) as RobustnessWeights;
}

/** Modelled round-trip cost in bps for one cell, or null without frictions. */
export function cellRoundTripBps(
  cell: SweepCell,
  opts: { baseFrictions?: Frictions; startingCash?: number },
): number | null {
  if (!opts.baseFrictions || opts.startingCash === undefined) return null;
  const tv = ticketValue(opts.startingCash, cell.ticket);
  // The cell already carries its own fully-resolved friction model; the
  // baseline is only needed for the terms the grid did not vary.
  const f = seriesBaseFrictions(cell.scenario.frictions, cell.scenario)
    ?? cell.scenario.frictions;
  void seriesBaseFrictions(opts.baseFrictions, cell.scenario);
  const bps = roundTripCostBps(f, tv);
  return Number.isFinite(bps) ? bps : null;
}

/** Score one already-grouped set of cells. */
export function scoreArm(
  arm: string,
  cells: readonly SweepCell[],
  opts: RobustnessOptions = {},
): RobustnessRow {
  if (cells.length === 0) throw new Error(`scoreArm: no cells for ${arm}`);
  const weights = resolveWeights(opts.weights);
  const returnScale = opts.returnScale ?? 20;

  const returns = cells.map((c) => c.totalReturnPct);
  const edges = cells.map((c) => cellScore(c, "benchmark"));
  const profitHitRate = returns.filter((r) => r > 0).length / cells.length;
  const benchmarkHitRate = edges.filter((e) => e > 0).length / cells.length;
  const medianReturnPct = median(returns);
  const worstReturnPct = Math.min(...returns);
  const bestReturnPct = Math.max(...returns);
  const medianSharpe = median(cells.map((c) => c.sharpe));
  const medianMaxDrawdownPct = median(cells.map((c) => Math.abs(c.maxDrawdownPct)));
  const medianTrades = median(cells.map((c) => c.trades));

  // Cost decay: how much return is lost per +10bps of round-trip cost.
  const bpsPairs = cells
    .map((c) => ({ bps: cellRoundTripBps(c, opts), ret: c.totalReturnPct }))
    .filter((p): p is { bps: number; ret: number } => p.bps !== null);
  const perBps = slope(
    bpsPairs.map((p) => p.bps),
    bpsPairs.map((p) => p.ret),
  );
  const returnPerTenBps = perBps === null ? null : perBps * 10;

  const components: RobustnessComponents = {
    profitHit: profitHitRate,
    benchmarkHit: benchmarkHitRate,
    medianReturn: squash(medianReturnPct, returnScale),
    // A grid whose worst cell is only mildly negative is far more
    // trustworthy than one with a single catastrophic corner.
    worstCase: squash(worstReturnPct, returnScale),
    sharpe: squash(medianSharpe, 1),
    // 0% drawdown → 1, 40% drawdown → 0.
    drawdown: Math.max(0, 1 - medianMaxDrawdownPct / 40),
    // No cost axis (or a flat one) is treated as neutral-good; a decay of
    // 5pp per 10bps scores zero.
    costStability:
      returnPerTenBps === null ? 0.5 : Math.max(0, 1 - Math.abs(returnPerTenBps) / 5),
  };

  const score =
    100 *
    (Object.keys(weights) as (keyof RobustnessWeights)[]).reduce(
      (sum, k) => sum + weights[k] * components[k],
      0,
    );

  const first = cells[0]!;
  const uniq = (vals: string[]) => {
    const set = [...new Set(vals)];
    return set.length === 1 ? set[0]! : "mixed";
  };

  return {
    arm,
    style: uniq(cells.map((c) => c.style)),
    riskLevel: uniq(cells.map((c) => c.riskLevel)),
    ticketLabel: uniq(cells.map((c) => c.ticket.label)),
    cells: cells.length,
    profitHitRate,
    benchmarkHitRate,
    medianReturnPct,
    worstReturnPct,
    bestReturnPct,
    medianSharpe,
    medianMaxDrawdownPct,
    medianTrades,
    returnPerTenBps,
    components,
    score: Number(score.toFixed(2)),
    grade: gradeFor(score),
    ...(first ? {} : {}),
  };
}

/**
 * Rank every arm in the sweep. Ties break on benchmark hit rate then
 * median return so the ordering is stable and reproducible.
 */
export function rankRobustness(
  cells: readonly SweepCell[],
  opts: RobustnessOptions = {},
): RobustnessRow[] {
  const groupBy = opts.groupBy ?? "risk+style+ticket";
  const rows = [...groupCells(cells, groupBy).entries()].map(([arm, group]) =>
    scoreArm(arm, group, opts),
  );
  return rows.sort(
    (a, b) =>
      b.score - a.score ||
      b.benchmarkHitRate - a.benchmarkHitRate ||
      b.medianReturnPct - a.medianReturnPct ||
      a.arm.localeCompare(b.arm),
  );
}

/** Distinct cost scenarios behind a set of cells — the grid width. */
export function gridWidth(cells: readonly SweepCell[]): number {
  return new Set(cells.map((c) => scenarioKey(c.scenario))).size;
}

// ---------------------------------------------------------------- output

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

export const ROBUSTNESS_COLUMNS = [
  "#",
  "arm",
  "score",
  "grade",
  "cells",
  "profitable",
  "beats B&H",
  "median ret %",
  "worst %",
  "best %",
  "sharpe",
  "maxDD %",
  "trades",
  "ret / +10bps",
] as const;

export function robustnessTableRows(rows: readonly RobustnessRow[]): string[][] {
  return rows.map((r, i) => [
    String(i + 1),
    r.arm,
    r.score.toFixed(1),
    r.grade,
    String(r.cells),
    pct(r.profitHitRate),
    pct(r.benchmarkHitRate),
    r.medianReturnPct.toFixed(1),
    r.worstReturnPct.toFixed(1),
    r.bestReturnPct.toFixed(1),
    r.medianSharpe.toFixed(2),
    r.medianMaxDrawdownPct.toFixed(1),
    r.medianTrades.toFixed(0),
    r.returnPerTenBps === null ? "-" : r.returnPerTenBps.toFixed(2),
  ]);
}

/** Fixed-width table for CLI output. */
export function formatRobustnessTable(rows: readonly RobustnessRow[]): string {
  const body = robustnessTableRows(rows);
  const cols = ROBUSTNESS_COLUMNS as readonly string[];
  const widths = cols.map((c, i) =>
    Math.max(c.length, ...body.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    cells.map((c, i) => (i === 1 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [line(cols), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

/** One-sentence verdict for the winning arm. */
export function summariseRobustness(rows: readonly RobustnessRow[]): string {
  const top = rows[0];
  if (!top) return "No cells to score.";
  const decay =
    top.returnPerTenBps === null
      ? ""
      : ` · ${top.returnPerTenBps >= 0 ? "+" : ""}${top.returnPerTenBps.toFixed(2)}pp per +10bps`;
  return (
    `Most robust: ${top.arm} — score ${top.score.toFixed(1)} (${top.grade}), ` +
    `profitable in ${pct(top.profitHitRate)} of ${top.cells} cost cells, ` +
    `beats buy & hold in ${pct(top.benchmarkHitRate)}, ` +
    `median ${top.medianReturnPct.toFixed(1)}% / worst ${top.worstReturnPct.toFixed(1)}%${decay}`
  );
}
