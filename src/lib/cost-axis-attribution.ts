// Cost-axis attribution for the viability frontier.
//
// The sweep tells us WHERE a strategy stops being viable; this module tells
// us WHY. For every failing cell on the grid we ask two counterfactuals:
//
//   1. Hold commission fixed, relax execution costs to the cheapest swept
//      slippage assumption. Does the cell become viable?
//   2. Hold slippage fixed, relax commission (scale + minimum fee) to the
//      cheapest swept assumption. Does the cell become viable?
//
// The answers partition every failure into: slippage-bound, commission-bound,
// bound by both (either axis alone rescues it), or strategy-bound (no cost
// relief inside the swept grid saves it — the edge simply is not there).
//
// It also surfaces example trade periods: the round trips whose modelled
// execution cost ate the largest share of their gross P&L, so the report
// shows concrete dates rather than only aggregate scores.
//
// Pure and deterministic: no clock, no network, no randomness.

import type { Frictions } from "./broker-simulator";
import {
  cellScore,
  roundTripCostBps,
  slippageBpsOf,
  ticketValue,
  type BreakevenTarget,
  type SweepCell,
} from "./cost-sweep";
import type { StyleTradeRow } from "./trading-style-backtest";

export type CostAxis = "slippage" | "commission" | "both" | "strategy";

/** Per-side / round-trip decomposition of a friction model at one ticket. */
export type CostSplit = {
  commissionBps: number;
  slippageBps: number;
  taxBps: number;
  totalBps: number;
  /** Commission share of the total round-trip cost, 0..1 (0 when total is 0). */
  commissionShare: number;
};

/**
 * Split the round-trip cost of one ticket into its commission, execution
 * (slippage/spread) and tax components, all in bps of notional.
 */
export function splitCostBps(frictions: Frictions, notional: number): CostSplit {
  if (!(notional > 0)) {
    return {
      commissionBps: Number.POSITIVE_INFINITY,
      slippageBps: Number.POSITIVE_INFINITY,
      taxBps: 0,
      totalBps: Number.POSITIVE_INFINITY,
      commissionShare: 0,
    };
  }
  const bps = frictions.commissionBps ?? 0;
  const min = frictions.minCommission ?? 0;
  const commissionPerSide = Math.max((bps / 10_000) * notional, min);
  const commissionBps = ((2 * commissionPerSide) / notional) * 10_000;
  const slippageBps = 2 * (frictions.slippageBps ?? 0);
  const taxBps = frictions.buyTaxBps ?? 0;
  const totalBps = commissionBps + slippageBps + taxBps;
  return {
    commissionBps,
    slippageBps,
    taxBps,
    totalBps,
    commissionShare: totalBps > 0 ? commissionBps / totalBps : 0,
  };
}

type ArmKey = string;

const armKey = (c: SweepCell): ArmKey => [c.riskLevel, c.style, c.ticket.label].join("|");
const slipLabelOf = (c: SweepCell): string => c.scenario.slippage?.label ?? "-";
const slipCostOf = (c: SweepCell): number =>
  c.scenario.slippage ? slippageBpsOf(c.scenario.slippage) : (c.scenario.frictions.slippageBps ?? 0);
const minFeeOf = (c: SweepCell): number =>
  c.scenario.minCommission ?? c.scenario.frictions.minCommission ?? 0;

const cellKey = (c: SweepCell): string =>
  [armKey(c), c.scenario.scale, slipLabelOf(c), minFeeOf(c)].join("|");

export type FailureAttribution = {
  riskLevel: string;
  style: string;
  ticketLabel: string;
  scenarioLabel: string;
  scale: number;
  slippageLabel: string;
  minCommission: number;
  /** Score at the failing cell (negative). */
  score: number;
  /** Score after relaxing only the execution-cost axis, null when unswept. */
  slippageReliefScore: number | null;
  /** Score after relaxing only the commission axis, null when unswept. */
  commissionReliefScore: number | null;
  /** Score gained by each relief (0 when that axis cannot be relaxed). */
  slippageGain: number;
  commissionGain: number;
  cause: CostAxis;
  split: CostSplit;
  totalReturnPct: number;
  benchmarkReturnPct: number;
  feeDragPct: number;
  trades: number;
};

export type AttributionSummary = {
  target: BreakevenTarget;
  cellsEvaluated: number;
  failures: number;
  counts: Record<CostAxis, number>;
  /** Axis responsible for the most failures ("strategy" excluded from the race). */
  dominantAxis: CostAxis | null;
  /** Mean score gain per axis across failures where the axis could be relaxed. */
  meanSlippageGain: number;
  meanCommissionGain: number;
  rows: FailureAttribution[];
};

/**
 * Attribute every failing cell on the grid to the cost axis that caused it.
 * A cell "fails" when its score against `target` is at or below zero.
 */
export function attributeFrontierFailures(
  cells: SweepCell[],
  opts: {
    baseFrictions?: Frictions;
    startingCash: number;
    target?: BreakevenTarget;
  },
): AttributionSummary {
  const target = opts.target ?? "zero";
  const byKey = new Map<string, SweepCell>();
  for (const c of cells) byKey.set(cellKey(c), c);

  // Cheapest swept value on each axis, computed per arm so a grid that
  // varies only one axis still attributes correctly.
  const cheapestSlip = new Map<ArmKey, { label: string; cost: number }>();
  const cheapestScale = new Map<ArmKey, number>();
  const cheapestMinFee = new Map<ArmKey, number>();
  for (const c of cells) {
    const k = armKey(c);
    const slip = { label: slipLabelOf(c), cost: slipCostOf(c) };
    const curSlip = cheapestSlip.get(k);
    if (!curSlip || slip.cost < curSlip.cost) cheapestSlip.set(k, slip);
    const scale = c.scenario.scale;
    const curScale = cheapestScale.get(k);
    if (curScale === undefined || scale < curScale) cheapestScale.set(k, scale);
    const fee = minFeeOf(c);
    const curFee = cheapestMinFee.get(k);
    if (curFee === undefined || fee < curFee) cheapestMinFee.set(k, fee);
  }

  const rows: FailureAttribution[] = [];
  const counts: Record<CostAxis, number> = {
    slippage: 0,
    commission: 0,
    both: 0,
    strategy: 0,
  };
  let slipGainSum = 0;
  let slipGainN = 0;
  let commGainSum = 0;
  let commGainN = 0;

  for (const cell of cells) {
    const score = cellScore(cell, target);
    if (score > 0) continue;
    const k = armKey(cell);

    const slipRelief = cheapestSlip.get(k);
    const slipReliefCell =
      slipRelief && slipRelief.label !== slipLabelOf(cell)
        ? byKey.get([k, cell.scenario.scale, slipRelief.label, minFeeOf(cell)].join("|"))
        : undefined;

    const loScale = cheapestScale.get(k);
    const loFee = cheapestMinFee.get(k);
    const commReliefCell =
      loScale !== undefined
        && loFee !== undefined
        && (loScale !== cell.scenario.scale || loFee !== minFeeOf(cell))
        ? byKey.get([k, loScale, slipLabelOf(cell), loFee].join("|"))
        : undefined;

    const slipReliefScore = slipReliefCell ? cellScore(slipReliefCell, target) : null;
    const commReliefScore = commReliefCell ? cellScore(commReliefCell, target) : null;
    const slippageGain = slipReliefScore === null ? 0 : slipReliefScore - score;
    const commissionGain = commReliefScore === null ? 0 : commReliefScore - score;
    if (slipReliefScore !== null) {
      slipGainSum += slippageGain;
      slipGainN += 1;
    }
    if (commReliefScore !== null) {
      commGainSum += commissionGain;
      commGainN += 1;
    }

    const slipFixes = slipReliefScore !== null && slipReliefScore > 0;
    const commFixes = commReliefScore !== null && commReliefScore > 0;
    const cause: CostAxis = slipFixes && commFixes
      ? "both"
      : slipFixes
        ? "slippage"
        : commFixes
          ? "commission"
          : "strategy";
    counts[cause] += 1;

    rows.push({
      riskLevel: cell.riskLevel,
      style: cell.style,
      ticketLabel: cell.ticket.label,
      scenarioLabel: cell.scenario.label,
      scale: cell.scenario.scale,
      slippageLabel: slipLabelOf(cell),
      minCommission: minFeeOf(cell),
      score,
      slippageReliefScore: slipReliefScore,
      commissionReliefScore: commReliefScore,
      slippageGain,
      commissionGain,
      cause,
      split: splitCostBps(
        cell.scenario.frictions,
        ticketValue(opts.startingCash, cell.ticket),
      ),
      totalReturnPct: cell.totalReturnPct,
      benchmarkReturnPct: cell.benchmarkReturnPct,
      feeDragPct: cell.feeDragPct,
      trades: cell.trades,
    });
  }

  // Rank the worst failures first so the report leads with the big misses.
  rows.sort((a, b) => a.score - b.score);

  const race: CostAxis[] = ["slippage", "commission", "both"];
  let dominantAxis: CostAxis | null = null;
  for (const axis of race) {
    if (counts[axis] === 0) continue;
    if (dominantAxis === null || counts[axis] > counts[dominantAxis]) dominantAxis = axis;
  }

  return {
    target,
    cellsEvaluated: cells.length,
    failures: rows.length,
    counts,
    dominantAxis,
    meanSlippageGain: slipGainN > 0 ? slipGainSum / slipGainN : 0,
    meanCommissionGain: commGainN > 0 ? commGainSum / commGainN : 0,
    rows,
  };
}

/** One matched buy → sell round trip reconstructed from a trade log. */
export type RoundTrip = {
  symbol: string;
  entryDate: string;
  exitDate: string;
  holdingDays: number;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  notional: number;
  grossPnl: number;
  /** Modelled all-in round-trip cost in currency units. */
  costAmount: number;
  costBps: number;
  netPnl: number;
  /** Cost as a share of |gross P&L| — >1 means costs flipped a winner. */
  costShareOfGross: number;
  /** True when gross was positive but net is not. */
  flippedByCosts: boolean;
  split: CostSplit;
};

const dayDiff = (a: string, b: string): number => {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86_400_000)) : 0;
};

/**
 * Pair trades into FIFO round trips per symbol and cost each one with the
 * scenario's friction model. Unmatched (still open) buys are ignored.
 */
export function pairRoundTrips(
  trades: StyleTradeRow[],
  frictions: Frictions,
): RoundTrip[] {
  const open = new Map<string, Array<{ date: string; qty: number; price: number }>>();
  const out: RoundTrip[] = [];
  const ordered = [...trades].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  for (const t of ordered) {
    const qty = Math.abs(Number(t.quantity) || 0);
    const price = Number(t.price) || 0;
    if (qty <= 0 || price <= 0) continue;
    if (t.side === "buy") {
      const lots = open.get(t.symbol) ?? [];
      lots.push({ date: t.date, qty, price });
      open.set(t.symbol, lots);
      continue;
    }
    let remaining = qty;
    const lots = open.get(t.symbol) ?? [];
    while (remaining > 1e-9 && lots.length > 0) {
      const lot = lots[0]!;
      const matched = Math.min(lot.qty, remaining);
      const notional = matched * lot.price;
      const grossPnl = (price - lot.price) * matched;
      const split = splitCostBps(frictions, notional);
      const costAmount = (split.totalBps / 10_000) * notional;
      const netPnl = grossPnl - costAmount;
      out.push({
        symbol: t.symbol,
        entryDate: lot.date,
        exitDate: t.date,
        holdingDays: dayDiff(lot.date, t.date),
        quantity: matched,
        entryPrice: lot.price,
        exitPrice: price,
        notional,
        grossPnl,
        costAmount,
        costBps: split.totalBps,
        netPnl,
        costShareOfGross: Math.abs(grossPnl) > 1e-9 ? costAmount / Math.abs(grossPnl) : Infinity,
        flippedByCosts: grossPnl > 0 && netPnl <= 0,
        split,
      });
      lot.qty -= matched;
      remaining -= matched;
      if (lot.qty <= 1e-9) lots.shift();
    }
    open.set(t.symbol, lots);
  }
  return out;
}

/**
 * The round trips where execution cost did the most damage — costs that
 * flipped a winner rank first, then the largest cost share of gross.
 */
export function worstCostPeriods(
  trips: RoundTrip[],
  limit = 8,
): RoundTrip[] {
  const scored = [...trips].filter((t) => t.costAmount > 0);
  scored.sort((a, b) => {
    if (a.flippedByCosts !== b.flippedByCosts) return a.flippedByCosts ? -1 : 1;
    const as = Number.isFinite(a.costShareOfGross) ? a.costShareOfGross : Number.MAX_VALUE;
    const bs = Number.isFinite(b.costShareOfGross) ? b.costShareOfGross : Number.MAX_VALUE;
    if (bs !== as) return bs - as;
    return b.costAmount - a.costAmount;
  });
  return scored.slice(0, Math.max(0, limit));
}

// --------------------------------------------------------------- reporting

export const ATTRIBUTION_COLUMNS = [
  "risk",
  "style",
  "ticket",
  "scenario",
  "cost split (comm/slip bps)",
  "score",
  "slip relief",
  "comm relief",
  "cause",
] as const;

const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "∞");

export function attributionTableRows(summary: AttributionSummary, limit = 40): string[][] {
  return summary.rows.slice(0, limit).map((r) => [
    r.riskLevel,
    r.style,
    r.ticketLabel,
    r.scenarioLabel,
    `${fmt(r.split.commissionBps, 0)} / ${fmt(r.split.slippageBps, 0)}`,
    `${fmt(r.score)}%`,
    r.slippageReliefScore === null ? "—" : `${fmt(r.slippageReliefScore)}% (+${fmt(r.slippageGain)})`,
    r.commissionReliefScore === null ? "—" : `${fmt(r.commissionReliefScore)}% (+${fmt(r.commissionGain)})`,
    r.cause,
  ]);
}

export const EXAMPLE_PERIOD_COLUMNS = [
  "symbol",
  "entry",
  "exit",
  "days",
  "notional",
  "gross P&L",
  "cost",
  "net P&L",
  "cost / gross",
  "verdict",
] as const;

export function examplePeriodRows(trips: RoundTrip[]): string[][] {
  return trips.map((t) => [
    t.symbol,
    t.entryDate,
    t.exitDate,
    String(t.holdingDays),
    `£${t.notional.toFixed(0)}`,
    `£${t.grossPnl.toFixed(2)}`,
    `£${t.costAmount.toFixed(2)} (${fmt(t.costBps, 0)}bps)`,
    `£${t.netPnl.toFixed(2)}`,
    Number.isFinite(t.costShareOfGross) ? `${(t.costShareOfGross * 100).toFixed(0)}%` : "n/a",
    t.flippedByCosts ? "costs flipped a winner" : t.netPnl < 0 ? "loser, costs added" : "survived costs",
  ]);
}

/** One-line verdict for the CLI and the report subtitle. */
export function summariseAttribution(summary: AttributionSummary): string {
  if (summary.failures === 0) {
    return `No viability failures across ${summary.cellsEvaluated} cells (target: ${summary.target}).`;
  }
  const { counts } = summary;
  const dominant = summary.dominantAxis;
  const dominantText = dominant === null
    ? "no cost axis rescues any failure — the edge, not the cost model, is the binding constraint"
    : dominant === "both"
      ? "most failures are rescued by relaxing either axis (jointly cost-bound)"
      : `${dominant} is the binding axis in most rescuable failures`;
  return (
    `${summary.failures}/${summary.cellsEvaluated} cells fail vs ${summary.target}: `
    + `${counts.slippage} slippage-bound, ${counts.commission} commission-bound, `
    + `${counts.both} either-axis, ${counts.strategy} strategy-bound — ${dominantText}. `
    + `Mean rescue: slippage +${fmt(summary.meanSlippageGain)}pp, commission +${fmt(summary.meanCommissionGain)}pp.`
  );
}

/** Fixed-width CLI table, mirroring the robustness table style. */
export function formatAttributionTable(summary: AttributionSummary, limit = 20): string {
  const rows = [[...ATTRIBUTION_COLUMNS], ...attributionTableRows(summary, limit)];
  const widths = ATTRIBUTION_COLUMNS.map((_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? "").length)),
  );
  return rows
    .map((r) => r.map((cell, i) => (cell ?? "").padEnd(widths[i]!)).join("  "))
    .join("\n");
}
