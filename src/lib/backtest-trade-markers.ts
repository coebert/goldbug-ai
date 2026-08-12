// Turns backtest trades into chart-ready markers.
//
// The RSI strategy backtest and the divergence backtest both produce trades
// with an entry and an exit date. To *verify* those fills you need to see them
// on the same tape they were derived from, so this module flattens either
// trade shape into a common marker/leg form that the price chart and the RSI
// pane can both draw without knowing which engine produced them.

import type { RsiTrade } from "./rsi-backtest";
import type { DivergenceTrade } from "./rsi-divergence-backtest";
import type { HistoryPoint } from "./market-symbol-history";

export type TradeDirection = "long" | "short";
export type TradeSide = "entry" | "exit";
export type MarkerTone = "positive" | "negative" | "neutral";

export interface TradeMarker {
  key: string;
  date: string;
  price: number;
  /** RSI at that bar, when the window is warm — used by the RSI pane. */
  rsi: number | null;
  side: TradeSide;
  direction: TradeDirection;
  /** Single-character glyph drawn on the marker. */
  glyph: string;
  tone: MarkerTone;
  /** Tooltip / list text. */
  detail: string;
}

export interface TradeLeg {
  key: string;
  fromDate: string;
  fromPrice: number;
  toDate: string;
  toPrice: number;
  direction: TradeDirection;
  netReturn: number;
  open: boolean;
}

export interface TradeOverlay {
  markers: TradeMarker[];
  legs: TradeLeg[];
}

export const EMPTY_TRADE_OVERLAY: TradeOverlay = { markers: [], legs: [] };

function rsiIndex(points: HistoryPoint[]): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (const p of points) m.set(p.date, typeof p.rsi14 === "number" ? p.rsi14 : null);
  return m;
}

function pct(v: number): string {
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
}

function entryGlyph(direction: TradeDirection): string {
  return direction === "long" ? "B" : "S";
}

function exitGlyph(direction: TradeDirection): string {
  return direction === "long" ? "S" : "B";
}

function toneFor(netReturn: number): MarkerTone {
  return netReturn > 0 ? "positive" : netReturn < 0 ? "negative" : "neutral";
}

/** Markers + legs for the long-only RSI zone strategy backtest. */
export function rsiTradeOverlay(trades: RsiTrade[], points: HistoryPoint[]): TradeOverlay {
  const rsi = rsiIndex(points);
  const markers: TradeMarker[] = [];
  const legs: TradeLeg[] = [];

  trades.forEach((t, i) => {
    const id = `rsi-${i}-${t.entryDate}`;
    markers.push({
      key: `${id}-entry`,
      date: t.entryDate,
      price: t.entryPrice,
      rsi: rsi.get(t.entryDate) ?? null,
      side: "entry",
      direction: "long",
      glyph: entryGlyph("long"),
      tone: "neutral",
      detail: `Buy ${t.entryPrice.toFixed(2)} on ${t.entryDate}`,
    });
    markers.push({
      key: `${id}-exit`,
      date: t.exitDate,
      price: t.exitPrice,
      rsi: rsi.get(t.exitDate) ?? null,
      side: "exit",
      direction: "long",
      glyph: exitGlyph("long"),
      tone: toneFor(t.netReturn),
      detail: `${t.open ? "Open at window end" : "Sell"} ${t.exitPrice.toFixed(2)} on ${t.exitDate} · ${pct(t.netReturn)} net over ${t.bars} bars`,
    });
    legs.push({
      key: `${id}-leg`,
      fromDate: t.entryDate,
      fromPrice: t.entryPrice,
      toDate: t.exitDate,
      toPrice: t.exitPrice,
      direction: "long",
      netReturn: t.netReturn,
      open: t.open,
    });
  });

  return { markers, legs };
}

/** Markers + legs for the divergence backtest (bullish long, bearish short). */
export function divergenceTradeOverlay(
  trades: DivergenceTrade[],
  points: HistoryPoint[],
): TradeOverlay {
  const rsi = rsiIndex(points);
  const markers: TradeMarker[] = [];
  const legs: TradeLeg[] = [];

  trades.forEach((t, i) => {
    const direction: TradeDirection = t.kind === "bullish" ? "long" : "short";
    const id = `div-${i}-${t.entryDate}`;
    markers.push({
      key: `${id}-entry`,
      date: t.entryDate,
      price: t.entryPrice,
      rsi: rsi.get(t.entryDate) ?? null,
      side: "entry",
      direction,
      glyph: entryGlyph(direction),
      tone: "neutral",
      detail: `${direction === "long" ? "Long" : "Short"} entry ${t.entryPrice.toFixed(2)} on ${t.entryDate} (${t.kind} divergence pivot ${t.pivotDate})`,
    });
    markers.push({
      key: `${id}-exit`,
      date: t.exitDate,
      price: t.exitPrice,
      rsi: rsi.get(t.exitDate) ?? null,
      side: "exit",
      direction,
      glyph: exitGlyph(direction),
      tone: toneFor(t.netReturn),
      detail: `Exit ${t.exitPrice.toFixed(2)} on ${t.exitDate} · ${t.outcome} · ${pct(t.netReturn)} net over ${t.bars} bars`,
    });
    legs.push({
      key: `${id}-leg`,
      fromDate: t.entryDate,
      fromPrice: t.entryPrice,
      toDate: t.exitDate,
      toPrice: t.exitPrice,
      direction,
      netReturn: t.netReturn,
      open: false,
    });
  });

  return { markers, legs };
}

/** Merge overlays (e.g. RSI strategy + divergence) for a single chart. */
export function mergeTradeOverlays(...overlays: TradeOverlay[]): TradeOverlay {
  return {
    markers: overlays.flatMap((o) => o.markers),
    legs: overlays.flatMap((o) => o.legs),
  };
}
