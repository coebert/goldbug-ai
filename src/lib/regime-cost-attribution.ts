/**
 * Per-regime cost decomposition for the walk-forward report.
 *
 * The regime table answers "does the edge survive bear/sideways tapes?".
 * It does not answer the follow-up question, which is the actionable one for
 * a small account: *when the edge does not survive, which cost axis killed
 * it?* A regime whose gross return is fine but whose net return is negative
 * because every ticket paid a £3 minimum needs a bigger ticket, not a better
 * signal. A regime bleeding on slippage needs slower, more patient execution
 * or more liquid names. Those are opposite fixes, so lumping them into one
 * "fee drag %" column hides the only number worth acting on.
 *
 * This module therefore splits realised trading cost into four axes —
 *
 *   rate commission : the bps schedule, irreducible at a given turnover
 *   minimum fee     : the per-ticket floor a bigger ticket would absorb free
 *   slippage        : spread crossing plus impact
 *   other           : stamp duty / FX / custody
 *
 * — and reports them separately for the *training* slice and the
 * *out-of-sample* slice of every walk-forward window. Comparing the two
 * matters: costs that look benign in-sample and explode out-of-sample mean
 * the parameter set was fitted to a cheaper tape than it will actually trade,
 * which is a fitting artefact rather than a cost problem.
 *
 * Everything here is pure arithmetic over fills the simulator already booked,
 * so it adds no backtest passes to the runner.
 */

import {
  EMPTY_FEE_DRAG,
  annualiseFeeDragPct,
  estimateFeeDrag,
  totalFeeDragPct,
  type FeeDragBreakdown,
  type FeeDragFrictions,
} from "@/lib/fee-drag-objective";
import { REGIMES, median, type RegimeLabel } from "@/lib/regime-walk-forward";

/** Which half of a walk-forward window a cost belongs to. */
export type CostPhase = "train" | "test";

export const COST_PHASES: readonly CostPhase[] = ["train", "test"] as const;

/** The axes a cost can be attributed to, most-actionable first. */
export type CostAxis = "min_fee" | "slippage" | "rate_commission" | "other";

export const COST_AXES: readonly CostAxis[] = [
  "min_fee",
  "slippage",
  "rate_commission",
  "other",
] as const;

export const COST_AXIS_LABEL: Record<CostAxis, string> = {
  min_fee: "minimum fee",
  slippage: "slippage",
  rate_commission: "commission rate",
  other: "tax/other",
};

/**
 * What each axis costs, as a share of starting equity, plus the annualised
 * view that can be compared against a CAGR figure.
 */
export type AxisCosts = Record<CostAxis, number>;

export const EMPTY_AXIS_COSTS: AxisCosts = {
  min_fee: 0,
  slippage: 0,
  rate_commission: 0,
  other: 0,
};

/**
 * `FeeDragBreakdown.commissionPct` is the *total* commission and includes the
 * minimum-fee floor as a subset. Splitting it out gives four disjoint axes
 * that sum to the total drag, which is what makes share arithmetic honest.
 */
export function axisCostsFromDrag(b: FeeDragBreakdown): AxisCosts {
  const minFee = Math.max(0, b.minFeePct);
  return {
    min_fee: minFee,
    slippage: Math.max(0, b.slippagePct),
    rate_commission: Math.max(0, b.commissionPct - minFee),
    other: Math.max(0, b.otherPct),
  };
}

export function totalAxisCost(a: AxisCosts): number {
  return a.min_fee + a.slippage + a.rate_commission + a.other;
}

/** Share of total cost each axis explains, 0..1. All zero when nothing traded. */
export function axisShares(a: AxisCosts): AxisCosts {
  const total = totalAxisCost(a);
  if (!(total > 1e-12)) return { ...EMPTY_AXIS_COSTS };
  return {
    min_fee: a.min_fee / total,
    slippage: a.slippage / total,
    rate_commission: a.rate_commission / total,
    other: a.other / total,
  };
}

export type DominantAxis = {
  axis: CostAxis | "none";
  /** Share of total cost the winning axis explains, 0..1. */
  share: number;
  /** True when that axis explains more than half of all cost. */
  majority: boolean;
};

/**
 * The axis carrying the most cost. Ties break toward the more actionable
 * axis (`COST_AXES` order), because when a minimum fee and slippage cost the
 * same the ticket-size fix is the cheaper one to attempt.
 */
export function dominantCostAxis(a: AxisCosts): DominantAxis {
  const total = totalAxisCost(a);
  if (!(total > 1e-12)) return { axis: "none", share: 0, majority: false };
  let best: CostAxis = COST_AXES[0]!;
  for (const axis of COST_AXES) if (a[axis] > a[best] + 1e-12) best = axis;
  const share = a[best] / total;
  return { axis: best, share, majority: share > 0.5 };
}

/** One filled order, with enough detail to attribute and to place in time. */
export type DatedFill = {
  date: string;
  notional: number;
  fee: number;
  side: "BUY" | "SELL";
};

/**
 * Split fills into the training slice and the out-of-sample slice. Boundaries
 * are dates rather than bar indices so this works off the trade log without
 * the caller having to re-derive bar positions.
 */
export function splitFillsByPhase(
  fills: readonly DatedFill[],
  bounds: { trainFrom: string; testFrom: string; testTo: string },
): Record<CostPhase, DatedFill[]> {
  const train: DatedFill[] = [];
  const test: DatedFill[] = [];
  for (const f of fills) {
    if (f.date < bounds.trainFrom || f.date > bounds.testTo) continue;
    if (f.date < bounds.testFrom) train.push(f);
    else test.push(f);
  }
  return { train, test };
}

/** Cost profile of one phase of one window. */
export type PhaseCosts = {
  phase: CostPhase;
  trades: number;
  years: number;
  /** Disjoint axis costs as % of starting equity over the phase. */
  axes: AxisCosts;
  /** Sum of the axes — total cost paid in the phase. */
  totalDragPct: number;
  /** Total cost expressed per year, comparable with a CAGR figure. */
  annualDragPct: number;
  dominant: DominantAxis;
};

export const EMPTY_PHASE_COSTS = (phase: CostPhase): PhaseCosts => ({
  phase,
  trades: 0,
  years: 0,
  axes: { ...EMPTY_AXIS_COSTS },
  totalDragPct: 0,
  annualDragPct: 0,
  dominant: { axis: "none", share: 0, majority: false },
});

export function phaseCosts(
  phase: CostPhase,
  fills: readonly DatedFill[],
  frictions: FeeDragFrictions | undefined,
  startingCash: number,
  bars: number,
): PhaseCosts {
  const years = bars > 0 ? bars / 252 : 0;
  if (fills.length === 0 || !(startingCash > 0)) {
    return { ...EMPTY_PHASE_COSTS(phase), years };
  }
  const drag = estimateFeeDrag(fills, frictions, startingCash);
  const axes = axisCostsFromDrag(drag);
  const totalDragPct = totalAxisCost(axes);
  return {
    phase,
    trades: fills.length,
    years,
    axes,
    totalDragPct,
    annualDragPct: annualiseFeeDragPct(totalDragPct, years),
    dominant: dominantCostAxis(axes),
  };
}

/** Both phases of one walk-forward window. */
export type WindowCosts = {
  train: PhaseCosts;
  test: PhaseCosts;
  /**
   * Out-of-sample annual drag minus in-sample annual drag, in points. A large
   * positive value means the config traded more expensively than the tape it
   * was tuned on — a fitting artefact, not just a cost.
   */
  dragDriftPct: number;
};

export function attributeWindowCosts(args: {
  fills: readonly DatedFill[];
  frictions: FeeDragFrictions | undefined;
  startingCash: number;
  trainFrom: string;
  testFrom: string;
  testTo: string;
  trainBars: number;
  testBars: number;
}): WindowCosts {
  const split = splitFillsByPhase(args.fills, {
    trainFrom: args.trainFrom,
    testFrom: args.testFrom,
    testTo: args.testTo,
  });
  const train = phaseCosts("train", split.train, args.frictions, args.startingCash, args.trainBars);
  const test = phaseCosts("test", split.test, args.frictions, args.startingCash, args.testBars);
  return { train, test, dragDriftPct: test.annualDragPct - train.annualDragPct };
}

// ------------------------------------------------------------ aggregation

/** Cost picture for every window that landed in one regime. */
export type RegimeCostSummary = {
  regime: RegimeLabel;
  windows: number;
  /** Median annualised cost, per phase. */
  medianAnnualDragPct: Record<CostPhase, number>;
  /** Cost-weighted axis mix out of sample, 0..1 per axis. */
  testAxisShares: AxisCosts;
  /** Cost-weighted axis mix in sample, for the fitting-artefact comparison. */
  trainAxisShares: AxisCosts;
  /** Axis explaining the most out-of-sample cost. */
  dominant: DominantAxis;
  /** Median (out-of-sample annual drag − in-sample annual drag), in points. */
  medianDragDriftPct: number;
  /**
   * Median gross CAGR implied by adding the drag back to net CAGR — what the
   * signal earned before the broker took its cut.
   */
  medianGrossCagrPct: number;
  medianNetCagrPct: number;
  /**
   * Share of gross return consumed by cost, 0..1+. Undefined-safe: 0 when the
   * strategy had no gross return to erode, 1 when cost ate all of it, and >1
   * when cost turned a positive gross into a negative net.
   */
  erosionShare: number;
  /** True when cost flipped a profitable gross return into a net loss. */
  costFlippedSign: boolean;
};

/** The per-window inputs the regime aggregation needs. */
export type CostWindowRow = {
  regime: RegimeLabel;
  netCagrPct: number;
  costs: WindowCosts;
};

/** Cost-weighted mean of the axis mix — big windows should dominate. */
function weightedAxisShares(phases: readonly PhaseCosts[]): AxisCosts {
  const totals = { ...EMPTY_AXIS_COSTS };
  for (const p of phases) {
    for (const axis of COST_AXES) totals[axis] += p.axes[axis];
  }
  return axisShares(totals);
}

export function emptyRegimeCostSummary(regime: RegimeLabel): RegimeCostSummary {
  return {
    regime,
    windows: 0,
    medianAnnualDragPct: { train: 0, test: 0 },
    testAxisShares: { ...EMPTY_AXIS_COSTS },
    trainAxisShares: { ...EMPTY_AXIS_COSTS },
    dominant: { axis: "none", share: 0, majority: false },
    medianDragDriftPct: 0,
    medianGrossCagrPct: 0,
    medianNetCagrPct: 0,
    erosionShare: 0,
    costFlippedSign: false,
  };
}

export function summariseRegimeCosts(
  regime: RegimeLabel,
  rows: readonly CostWindowRow[],
): RegimeCostSummary {
  const mine = rows.filter((r) => r.regime === regime);
  if (mine.length === 0) return emptyRegimeCostSummary(regime);

  const testAxisShares = weightedAxisShares(mine.map((r) => r.costs.test));
  const trainAxisShares = weightedAxisShares(mine.map((r) => r.costs.train));
  const testTotals = { ...EMPTY_AXIS_COSTS };
  for (const r of mine) for (const a of COST_AXES) testTotals[a] += r.costs.test.axes[a];

  const medianNetCagrPct = median(mine.map((r) => r.netCagrPct));
  // Gross is reconstructed per window then aggregated, so windows with very
  // different horizons cannot smear their annualisation into one another.
  const medianGrossCagrPct = median(
    mine.map((r) => r.netCagrPct + r.costs.test.annualDragPct),
  );
  const medianTestDrag = median(mine.map((r) => r.costs.test.annualDragPct));

  const erosionShare =
    medianGrossCagrPct > 1e-9 ? Math.max(0, medianTestDrag) / medianGrossCagrPct : 0;

  return {
    regime,
    windows: mine.length,
    medianAnnualDragPct: {
      train: median(mine.map((r) => r.costs.train.annualDragPct)),
      test: medianTestDrag,
    },
    testAxisShares,
    trainAxisShares,
    dominant: dominantCostAxis(testTotals),
    medianDragDriftPct: median(mine.map((r) => r.costs.dragDriftPct)),
    medianGrossCagrPct,
    medianNetCagrPct,
    erosionShare,
    costFlippedSign: medianGrossCagrPct > 0 && medianNetCagrPct <= 0,
  };
}

export function buildRegimeCostReport(
  rows: readonly CostWindowRow[],
): RegimeCostSummary[] {
  return REGIMES.map((r) => summariseRegimeCosts(r, rows));
}

// ---------------------------------------------------------------- output

export const REGIME_COST_COLUMNS = [
  "regime",
  "gross CAGR %",
  "net CAGR %",
  "IS drag %/yr",
  "OOS drag %/yr",
  "drift",
  "min fee",
  "slippage",
  "comm rate",
  "other",
  "erosion",
  "dominant cost",
] as const;

const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "-");
const pct = (v: number) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : "-");

export function regimeCostTableRows(summaries: readonly RegimeCostSummary[]): string[][] {
  return summaries.map((s) => [
    s.regime,
    s.windows === 0 ? "-" : f1(s.medianGrossCagrPct),
    s.windows === 0 ? "-" : f1(s.medianNetCagrPct),
    f1(s.medianAnnualDragPct.train),
    f1(s.medianAnnualDragPct.test),
    `${s.medianDragDriftPct >= 0 ? "+" : ""}${f1(s.medianDragDriftPct)}`,
    pct(s.testAxisShares.min_fee),
    pct(s.testAxisShares.slippage),
    pct(s.testAxisShares.rate_commission),
    pct(s.testAxisShares.other),
    s.windows === 0 ? "-" : pct(s.erosionShare),
    s.dominant.axis === "none"
      ? "no cost"
      : `${COST_AXIS_LABEL[s.dominant.axis]} ${pct(s.dominant.share)}`,
  ]);
}

/**
 * A plain-language verdict per regime: what to change, not just what it cost.
 */
export function explainRegimeCosts(s: RegimeCostSummary): string {
  if (s.windows === 0) return `${s.regime}: no windows — nothing to attribute.`;
  if (s.dominant.axis === "none") {
    return `${s.regime}: no trading cost recorded (the strategy barely traded here).`;
  }
  const axis = COST_AXIS_LABEL[s.dominant.axis];
  const head =
    `${s.regime}: ${f1(s.medianAnnualDragPct.test)}%/yr out-of-sample cost eats `
    + `${pct(s.erosionShare)} of a ${f1(s.medianGrossCagrPct)}% gross CAGR; `
    + `${axis} explains ${pct(s.dominant.share)} of it`;

  const fix =
    s.dominant.axis === "min_fee"
      ? " — raise ticket size or cut trade count; the floor, not the rate, is the problem."
      : s.dominant.axis === "slippage"
        ? " — trade more liquid names or work orders more patiently."
        : s.dominant.axis === "rate_commission"
          ? " — only lower turnover helps; the rate itself is fixed."
          : " — stamp duty/FX dominates; prefer non-taxed instruments or fewer currencies.";

  const drift =
    s.medianDragDriftPct > 1
      ? ` Costs ran ${f1(s.medianDragDriftPct)} points/yr hotter out of sample than in training, `
        + "so the parameter set was tuned on a cheaper tape than it trades."
      : s.medianDragDriftPct < -1
        ? ` Costs were ${f1(-s.medianDragDriftPct)} points/yr lower out of sample than in training.`
        : "";

  const flip = s.costFlippedSign
    ? " Cost alone turned a profitable gross return into a net loss."
    : "";

  return head + fix + drift + flip;
}

/** The one-line headline across all regimes, for the report summary block. */
export function summariseCostAttribution(summaries: readonly RegimeCostSummary[]): string {
  const active = summaries.filter((s) => s.windows > 0 && s.dominant.axis !== "none");
  if (active.length === 0) return "No trading cost recorded in any regime.";
  const totals = { ...EMPTY_AXIS_COSTS };
  for (const s of active) {
    for (const a of COST_AXES) totals[a] += s.testAxisShares[a] * s.medianAnnualDragPct.test;
  }
  const overall = dominantCostAxis(totals);
  const worst = active.reduce((a, b) => (b.erosionShare > a.erosionShare ? b : a));
  const label = overall.axis === "none" ? "cost" : COST_AXIS_LABEL[overall.axis];
  return (
    `Across regimes, ${label} is the largest cost axis (${pct(overall.share)} of drag). `
    + `Erosion is worst in ${worst.regime}: ${pct(worst.erosionShare)} of gross return.`
  );
}

export { EMPTY_FEE_DRAG, totalFeeDragPct };
