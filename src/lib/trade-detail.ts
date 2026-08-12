// One shape for "what actually happened on this trade", so the details drawer
// can describe an RSI-zone trade and a divergence setup with the same fields.
//
// Gross return is recomputed from the executed prices (direction aware) so the
// friction line is the honest difference between the tape and what the
// strategy kept after costs.

import type { RsiTrade } from "./rsi-backtest";
import type { DivergenceTrade } from "./rsi-divergence-backtest";
import { divergenceTradeId, rsiTradeId, type TradeDirection } from "./backtest-trade-markers";

export type InvalidationStatus = "broken" | "held" | "not_applicable";

export interface TradeDetail {
  tradeId: string;
  /** Which engine produced the trade. */
  source: "RSI zone strategy" | "RSI divergence";
  title: string;
  direction: TradeDirection;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  bars: number;
  /** Price move in the trade's direction, before costs. */
  grossReturn: number;
  /** After round-trip friction. */
  netReturn: number;
  /** grossReturn - netReturn, i.e. what execution cost. */
  frictionCost: number;
  /** Still open at the end of the window. */
  open: boolean;
  outcome: string;
  invalidationStatus: InvalidationStatus;
  /** Price level that invalidated the setup, when the engine tracks one. */
  invalidationLevel: number | null;
  /** Best favourable excursion while open, as a fraction, when tracked. */
  mfe: number | null;
  /** Worst adverse excursion while open, as a positive fraction, when tracked. */
  mae: number | null;
  /** Extra context line (e.g. the divergence pivot bar). */
  note: string | null;
}

function grossOf(entry: number, exit: number, direction: TradeDirection): number {
  if (!Number.isFinite(entry) || entry === 0) return 0;
  const move = (exit - entry) / entry;
  return direction === "long" ? move : -move;
}

export function rsiTradeDetail(t: RsiTrade): TradeDetail {
  const grossReturn = grossOf(t.entryPrice, t.exitPrice, "long");
  return {
    tradeId: rsiTradeId(t),
    source: "RSI zone strategy",
    title: `Long ${t.entryDate} → ${t.exitDate}`,
    direction: "long",
    entryDate: t.entryDate,
    entryPrice: t.entryPrice,
    exitDate: t.exitDate,
    exitPrice: t.exitPrice,
    bars: t.bars,
    grossReturn,
    netReturn: t.netReturn,
    frictionCost: grossReturn - t.netReturn,
    open: t.open,
    outcome: t.open ? "Still open at window end" : t.netReturn >= 0 ? "Closed in profit" : "Closed at a loss",
    invalidationStatus: "not_applicable",
    invalidationLevel: null,
    mfe: null,
    mae: null,
    note: "Exit is the RSI zone signal that closed the position.",
  };
}

const DIVERGENCE_OUTCOME_LABEL: Record<DivergenceTrade["outcome"], string> = {
  reversal: "Reversal hit the target",
  failed: "Failed — invalidation level broke",
  timeout: "Timed out at the horizon",
};

export function divergenceTradeDetail(t: DivergenceTrade): TradeDetail {
  const direction: TradeDirection = t.kind === "bullish" ? "long" : "short";
  const grossReturn = grossOf(t.entryPrice, t.exitPrice, direction);
  return {
    tradeId: divergenceTradeId(t),
    source: "RSI divergence",
    title: `${t.kind === "bullish" ? "Long" : "Short"} ${t.entryDate} → ${t.exitDate}`,
    direction,
    entryDate: t.entryDate,
    entryPrice: t.entryPrice,
    exitDate: t.exitDate,
    exitPrice: t.exitPrice,
    bars: t.bars,
    grossReturn,
    netReturn: t.netReturn,
    frictionCost: grossReturn - t.netReturn,
    open: false,
    outcome: DIVERGENCE_OUTCOME_LABEL[t.outcome],
    invalidationStatus: t.outcome === "failed" ? "broken" : "held",
    invalidationLevel: t.invalidation,
    mfe: t.mfe,
    mae: t.mae,
    note: `${t.kind} divergence confirmed at the ${t.pivotDate} pivot; entry taken 3 bars later.`,
  };
}
