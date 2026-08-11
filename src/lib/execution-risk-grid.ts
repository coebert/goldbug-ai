/**
 * Risk-level tuning: a small grid search over the sizing knob, scored on the
 * same out-of-sample walk-forward folds the coupling work uses, reported as a
 * Pareto frontier of profit vs drawdown.
 *
 * The "risk level" is one scalar in [0, 1]. It is deliberately not a free-form
 * bag of parameters: the live engine exposes low / balanced / high, so the
 * tuning surface has to be a single dial that a person can actually turn. The
 * dial moves two things at once, the way real risk appetite does:
 *
 *   - concentration: how many names the book is spread across (more risk =
 *     fewer, larger positions)
 *   - deployment: how much of equity is allowed to be invested at all (more
 *     risk = less cash held back)
 *
 * Nothing here knows about correlations or shocks. It consumes whatever
 * (return, drawdown, cost) a simulated arm produced and answers one question:
 * which risk levels are not strictly worse than some other risk level?
 */

/** The sizing rules a risk level expands into, as the simulator consumes them. */
export type RiskSizing = {
  /** Maximum concurrent positions; equity is split evenly across the slots. */
  maxPositions: number;
  /** Fraction of available cash a single entry may consume. */
  exposureFraction: number;
};

export type RiskGridOptions = {
  /** Position count at risk 0 and risk 1. Risk up = concentration up. */
  maxPositionsAtLow: number;
  maxPositionsAtHigh: number;
  /** Deployment at risk 0 and risk 1. Risk up = less cash held back. */
  exposureAtLow: number;
  exposureAtHigh: number;
};

export const DEFAULT_RISK_GRID_OPTIONS: RiskGridOptions = {
  maxPositionsAtLow: 10,
  maxPositionsAtHigh: 3,
  exposureAtLow: 0.4,
  exposureAtHigh: 0.98,
};

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Expand a risk level into sizing rules. Monotone by construction: a higher
 * risk level never yields more positions or less deployment, so the grid
 * search cannot be reading a non-monotone knob as if it were ordered.
 */
export function riskSizingFor(
  risk: number,
  opts: RiskGridOptions = DEFAULT_RISK_GRID_OPTIONS,
): RiskSizing {
  const t = clamp01(risk);
  return {
    maxPositions: Math.max(1, Math.round(lerp(opts.maxPositionsAtLow, opts.maxPositionsAtHigh, t))),
    exposureFraction: clamp01(lerp(opts.exposureAtLow, opts.exposureAtHigh, t)),
  };
}

/** Evenly spaced risk levels in [lo, hi], inclusive of both ends. */
export function riskGridLevels(steps: number, lo = 0, hi = 1): number[] {
  if (steps < 1) throw new Error("riskGridLevels needs at least 1 step");
  if (steps === 1) return [lo];
  const out: number[] = [];
  for (let i = 0; i < steps; i++) out.push(lo + ((hi - lo) * i) / (steps - 1));
  // Snap to 4dp so labels and dedupe keys are stable across platforms.
  return [...new Set(out.map((x) => Number(x.toFixed(4))))];
}

/** One risk level's out-of-sample outcome, pooled over folds and paths. */
export type RiskGridRow = {
  risk: number;
  sizing: RiskSizing;
  /** Median across paths of total return over the scored windows, in %. */
  returnPct: number;
  /** 5% CVaR of the path return distribution, in %. */
  cvar5Pct: number;
  /** Median across paths of the worst drawdown seen, in % (negative). */
  drawdownPct: number;
  /** Worst single path drawdown, in % (negative). */
  worstDrawdownPct: number;
  /** Share of paths breaching the headline drawdown threshold. */
  breachProb: number;
  /** Median total execution cost, in currency units. */
  cost: number;
  /** Median number of fills, as a churn sanity check. */
  fills: number;
};

/**
 * Pareto dominance on the two objectives the user asked for: more profit,
 * shallower drawdown. `a` dominates `b` when it is at least as good on both
 * and strictly better on one. Ties on both axes are not dominance, so
 * duplicate outcomes both survive and the caller can see the plateau.
 */
export function dominates(a: RiskGridRow, b: RiskGridRow): boolean {
  const retAtLeast = a.returnPct >= b.returnPct;
  const ddAtLeast = a.drawdownPct >= b.drawdownPct; // less negative = shallower
  const strictly = a.returnPct > b.returnPct || a.drawdownPct > b.drawdownPct;
  return retAtLeast && ddAtLeast && strictly;
}

/** Non-dominated rows, ordered by drawdown from shallowest to deepest. */
export function paretoFrontier(rows: readonly RiskGridRow[]): RiskGridRow[] {
  const front = rows.filter((r) => !rows.some((o) => dominates(o, r)));
  return [...front].sort((a, b) => b.drawdownPct - a.drawdownPct);
}

/**
 * Return per unit of drawdown. Used only to nominate a knee on the frontier —
 * it is a reading aid, not an objective, and a row with no drawdown at all
 * (a book that never traded) is excluded rather than scored as infinite.
 */
export function returnPerDrawdown(row: RiskGridRow): number | null {
  const dd = Math.abs(row.drawdownPct);
  if (dd < 1e-9) return null;
  return row.returnPct / dd;
}

export type RiskGridReport = {
  rows: RiskGridRow[];
  frontier: RiskGridRow[];
  /** Best return-per-drawdown point on the frontier, if one is scoreable. */
  knee: RiskGridRow | null;
  /** Frontier rows that are strictly loss-making — profit is not on offer there. */
  lossMaking: RiskGridRow[];
  /** Risk levels the grid rejected because something else beat them on both axes. */
  dominated: RiskGridRow[];
  breachThresholdPct: number;
};

export function riskGridReport(
  rows: readonly RiskGridRow[],
  breachThresholdPct: number,
): RiskGridReport {
  if (!rows.length) throw new Error("riskGridReport needs at least one scored risk level");
  const sorted = [...rows].sort((a, b) => a.risk - b.risk);
  const frontier = paretoFrontier(sorted);
  const onFront = new Set(frontier.map((r) => r.risk));
  const scored = frontier
    .map((r) => ({ r, s: returnPerDrawdown(r) }))
    .filter((x): x is { r: RiskGridRow; s: number } => x.s !== null && x.r.returnPct > 0);
  const knee = scored.length
    ? scored.reduce((best, x) => (x.s > best.s ? x : best)).r
    : null;
  return {
    rows: sorted,
    frontier,
    knee,
    lossMaking: frontier.filter((r) => r.returnPct <= 0),
    dominated: sorted.filter((r) => !onFront.has(r.risk)),
    breachThresholdPct,
  };
}

const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);
const pct = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;

export function formatRiskGrid(report: RiskGridReport): string {
  const lines: string[] = [];
  const head = [
    pad("risk", 6), padL("slots", 6), padL("deploy", 7), padL("return", 9),
    padL("CVaR5", 9), padL("medDD", 8), padL("worstDD", 9),
    padL(`P(DD<${-report.breachThresholdPct}%)`, 14), padL("cost", 9), padL("fills", 7), "  pareto",
  ].join(" ");
  lines.push(head);
  lines.push("-".repeat(head.length));
  const onFront = new Set(report.frontier.map((r) => r.risk));
  for (const r of report.rows) {
    lines.push([
      pad(r.risk.toFixed(2), 6),
      padL(String(r.sizing.maxPositions), 6),
      padL(`${(r.sizing.exposureFraction * 100).toFixed(0)}%`, 7),
      padL(pct(r.returnPct), 9),
      padL(pct(r.cvar5Pct), 9),
      padL(pct(r.drawdownPct, 1), 8),
      padL(pct(r.worstDrawdownPct, 1), 9),
      padL(`${(r.breachProb * 100).toFixed(0)}%`, 14),
      padL(`£${Math.round(r.cost)}`, 9),
      padL(r.fills.toFixed(0), 7),
      r.risk === report.knee?.risk ? "  ★ knee" : onFront.has(r.risk) ? "  ✓" : "",
    ].join(" "));
  }
  lines.push("");
  lines.push(
    `Pareto frontier (${report.frontier.length}/${report.rows.length} risk levels survive): `
    + report.frontier.map((r) => `${r.risk.toFixed(2)} (${pct(r.returnPct)} / ${pct(r.drawdownPct, 1)} DD)`).join("  →  "),
  );
  if (report.knee) {
    lines.push(
      `Knee: risk ${report.knee.knee_label ?? report.knee.risk.toFixed(2)} — `
      + `${pct(report.knee.returnPct)} for ${pct(report.knee.drawdownPct, 1)} drawdown `
      + `(${returnPerDrawdown(report.knee)!.toFixed(2)} return per unit of drawdown).`,
    );
  } else {
    lines.push("Knee: none — no frontier point is profitable, so there is no profit/drawdown trade to make.");
  }
  if (report.lossMaking.length === report.frontier.length) {
    lines.push("Every surviving risk level loses money; the frontier is only ranking how you lose it.");
  }
  return lines.join("\n");
}

// Keeps `formatRiskGrid` honest about optional labelling without widening the row type.
declare module "./execution-risk-grid" {}
