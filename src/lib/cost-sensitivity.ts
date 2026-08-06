/**
 * Slippage × commission sensitivity analysis.
 *
 * The cost *sweep* answers "how far do all-in costs have to fall before the
 * rules are viable?" by scaling every friction term together. That conflates
 * two very different things: slippage (proportional, scales with notional) and
 * the fixed per-trade commission (a tax on trade COUNT, brutal on small
 * tickets). This module separates them into an explicit 2-D grid —
 *
 *     slippage bps ∈ {2 … 20}   ×   $ per trade ∈ {0 … 8}
 *
 * — so the report shows which of the two actually breaks the strategy, and how
 * steep the decay is in each direction (the elasticities below).
 *
 * Pure and deterministic: no network, no database, no broker.
 */
import type { Frictions } from "./broker-simulator";

/** One point on the grid: a slippage level and a fixed per-trade commission. */
export type SensitivityPoint = {
  /** Half-spread + impact assumption applied per side, in bps of notional. */
  slippageBps: number;
  /** Fixed cash commission floor per executed order, in account currency. */
  perTrade: number;
};

export type SensitivityCell = SensitivityPoint & {
  style: string;
  riskLevel: string;
  totalReturnPct: number;
  benchmarkReturnPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  trades: number;
  feeDragPct: number;
};

/** Default axes: ±2bps → ±20bps of slippage, $0 → $8 per trade. */
export const DEFAULT_SLIPPAGE_BPS = [2, 5, 8, 12, 16, 20];
export const DEFAULT_PER_TRADE = [0, 1, 3, 5, 8];

/**
 * Override only the two axis terms on a baseline friction model, leaving
 * commissionBps / buyTaxBps / impact exactly as configured. Keeping the rest
 * fixed is what makes a cell attributable to one axis.
 */
export function frictionsAt(base: Frictions, point: SensitivityPoint): Frictions {
  if (!Number.isFinite(point.slippageBps) || point.slippageBps < 0) {
    throw new Error(`frictionsAt: invalid slippageBps ${point.slippageBps}`);
  }
  if (!Number.isFinite(point.perTrade) || point.perTrade < 0) {
    throw new Error(`frictionsAt: invalid perTrade ${point.perTrade}`);
  }
  return { ...base, slippageBps: point.slippageBps, minCommission: point.perTrade };
}

/** Cartesian product of the two axes, slippage-major (row = slippage). */
export function buildSensitivityGrid(
  slippageBps: readonly number[] = DEFAULT_SLIPPAGE_BPS,
  perTrade: readonly number[] = DEFAULT_PER_TRADE,
): SensitivityPoint[] {
  const out: SensitivityPoint[] = [];
  for (const s of slippageBps) for (const c of perTrade) out.push({ slippageBps: s, perTrade: c });
  return out;
}

export type SensitivityTarget = "zero" | "benchmark";

/** Signed margin for a cell: positive = the rules still clear the bar. */
export function cellMargin(cell: SensitivityCell, target: SensitivityTarget = "zero"): number {
  return target === "zero"
    ? cell.totalReturnPct
    : cell.totalReturnPct - cell.benchmarkReturnPct;
}

/**
 * Least-squares slope of return (% points) per unit of one axis, holding the
 * other axis fixed at each of its levels and averaging the slopes. This is the
 * "how much does one extra bp / one extra dollar cost me?" number.
 */
export function axisElasticity(
  cells: readonly SensitivityCell[],
  axis: "slippageBps" | "perTrade",
  target: SensitivityTarget = "zero",
): number | null {
  const other = axis === "slippageBps" ? "perTrade" : "slippageBps";
  const groups = new Map<number, SensitivityCell[]>();
  for (const c of cells) {
    const arr = groups.get(c[other]) ?? [];
    arr.push(c);
    groups.set(c[other], arr);
  }
  const slopes: number[] = [];
  for (const arr of groups.values()) {
    const xs = arr.map((c) => c[axis]);
    const ys = arr.map((c) => cellMargin(c, target));
    const n = xs.length;
    if (n < 2) continue;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    const varX = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    if (varX <= 0) continue;
    const cov = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0);
    slopes.push(cov / varX);
  }
  if (slopes.length === 0) return null;
  return slopes.reduce((a, b) => a + b, 0) / slopes.length;
}

export type RobustnessSummary = {
  style: string;
  riskLevel: string;
  cells: number;
  /** Share of grid cells (0-1) where the margin is positive. */
  survivalRate: number;
  bestCell: SensitivityCell | null;
  worstCell: SensitivityCell | null;
  /** Return % points lost per additional bp of slippage. */
  slippageElasticity: number | null;
  /** Return % points lost per additional $ of fixed commission. */
  perTradeElasticity: number | null;
  /** Highest slippage level that stays positive at the cheapest commission. */
  maxViableSlippageBps: number | null;
  /** Highest per-trade fee that stays positive at the tightest slippage. */
  maxViablePerTrade: number | null;
  verdict: "robust" | "fragile" | "breaks";
};

const bestBy = (cells: readonly SensitivityCell[], t: SensitivityTarget, sign: 1 | -1) =>
  cells.length === 0
    ? null
    : cells.reduce((a, b) => (sign * cellMargin(b, t) > sign * cellMargin(a, t) ? b : a));

/**
 * Summarise one (style × risk level) grid: how much of it survives, which
 * axis hurts more, and how far each axis can be pushed before the edge dies.
 */
export function summariseRobustness(
  cells: readonly SensitivityCell[],
  target: SensitivityTarget = "zero",
): RobustnessSummary {
  const survivors = cells.filter((c) => cellMargin(c, target) > 0);
  const survivalRate = cells.length ? survivors.length / cells.length : 0;

  const minPerTrade = cells.length ? Math.min(...cells.map((c) => c.perTrade)) : null;
  const minSlippage = cells.length ? Math.min(...cells.map((c) => c.slippageBps)) : null;

  const viableSlips = survivors
    .filter((c) => c.perTrade === minPerTrade)
    .map((c) => c.slippageBps);
  const viableFees = survivors
    .filter((c) => c.slippageBps === minSlippage)
    .map((c) => c.perTrade);

  return {
    style: cells[0]?.style ?? "",
    riskLevel: cells[0]?.riskLevel ?? "",
    cells: cells.length,
    survivalRate,
    bestCell: bestBy(cells, target, 1),
    worstCell: bestBy(cells, target, -1),
    slippageElasticity: axisElasticity(cells, "slippageBps", target),
    perTradeElasticity: axisElasticity(cells, "perTrade", target),
    maxViableSlippageBps: viableSlips.length ? Math.max(...viableSlips) : null,
    maxViablePerTrade: viableFees.length ? Math.max(...viableFees) : null,
    // Robust = survives most of the grid including the expensive corner.
    verdict: survivalRate >= 0.75 ? "robust" : survivalRate >= 0.25 ? "fragile" : "breaks",
  };
}

/** Which axis dominates the decay, normalised over the swept ranges. */
export function dominantCostAxis(
  summary: RobustnessSummary,
  slippageRange: number,
  perTradeRange: number,
): "slippage" | "commission" | "balanced" | null {
  const s = summary.slippageElasticity;
  const c = summary.perTradeElasticity;
  if (s === null || c === null) return null;
  // Compare total damage across each swept range, not per-unit slopes: one bp
  // and one dollar are not comparable units.
  const sImpact = Math.abs(s * slippageRange);
  const cImpact = Math.abs(c * perTradeRange);
  const total = sImpact + cImpact;
  if (total <= 0) return "balanced";
  if (sImpact / total >= 0.6) return "slippage";
  if (cImpact / total >= 0.6) return "commission";
  return "balanced";
}

/**
 * Grid as rows (one per slippage level) of margins, ready for a heatmap table.
 * Row/column order follows the axes given, not insertion order.
 */
export function toMarginGrid(
  cells: readonly SensitivityCell[],
  slippageBps: readonly number[],
  perTrade: readonly number[],
  target: SensitivityTarget = "zero",
): Array<{ slippageBps: number; margins: Array<number | null> }> {
  return slippageBps.map((s) => ({
    slippageBps: s,
    margins: perTrade.map((c) => {
      const hit = cells.find((x) => x.slippageBps === s && x.perTrade === c);
      return hit ? cellMargin(hit, target) : null;
    }),
  }));
}

const pct = (v: number | null, d = 1) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}`);

/** One-line CLI/report summary of a robustness result. */
export function formatRobustness(s: RobustnessSummary): string {
  const slip =
    s.maxViableSlippageBps === null ? "none" : `${s.maxViableSlippageBps}bps`;
  const fee = s.maxViablePerTrade === null ? "none" : `$${s.maxViablePerTrade}`;
  return (
    `${s.verdict} — ${(s.survivalRate * 100).toFixed(0)}% of ${s.cells} cells positive; ` +
    `${pct(s.slippageElasticity, 2)}%/bp slippage, ${pct(s.perTradeElasticity, 2)}%/$ commission; ` +
    `survives to ${slip} slippage and ${fee}/trade`
  );
}
