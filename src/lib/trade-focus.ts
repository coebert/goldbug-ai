// Click-to-highlight support for backtest fills.
//
// Selecting a simulated trade should *jump the chart to it*: the price/RSI
// panes zoom to a padded window around the entry and exit bars, the fills for
// that trade stay drawn, and every other fill is clipped away so the selected
// leg is unambiguous.

import type { HistoryPoint } from "./market-symbol-history";
import type { TradeOverlay } from "./backtest-trade-markers";

export interface TradeFocus {
  /** Stable id shared by the trade list row and the chart markers. */
  tradeId: string;
  fromDate: string;
  toDate: string;
  label: string;
}

/** Bars of context drawn either side of the focused trade. */
export const TRADE_FOCUS_PAD_BARS = 8;
/** Never zoom tighter than this — a 2-bar chart is unreadable. */
export const TRADE_FOCUS_MIN_BARS = 12;

function indexOfDate(points: HistoryPoint[], date: string): number {
  return points.findIndex((p) => p.date === date);
}

/**
 * Slice the tape down to the focused trade plus padding. Returns the full tape
 * when the focus is null or its dates are not on this window.
 */
export function focusPoints(
  points: HistoryPoint[],
  focus: TradeFocus | null,
  padBars = TRADE_FOCUS_PAD_BARS,
): HistoryPoint[] {
  if (!focus || points.length === 0) return points;

  const a = indexOfDate(points, focus.fromDate);
  const b = indexOfDate(points, focus.toDate);
  if (a < 0 || b < 0) return points;

  let start = Math.max(0, Math.min(a, b) - padBars);
  let end = Math.min(points.length - 1, Math.max(a, b) + padBars);

  // Widen symmetrically until the window is readable.
  while (end - start + 1 < TRADE_FOCUS_MIN_BARS && (start > 0 || end < points.length - 1)) {
    if (start > 0) start -= 1;
    if (end < points.length - 1) end += 1;
  }

  return points.slice(start, end + 1);
}

/**
 * Drop markers and legs that fall outside the visible window so a zoomed chart
 * does not stretch its domain to reach fills it is not showing.
 */
export function clipOverlayToWindow(overlay: TradeOverlay, points: HistoryPoint[]): TradeOverlay {
  if (points.length === 0) return overlay;
  const first = points[0]!.date;
  const last = points[points.length - 1]!.date;
  const inside = (d: string) => d >= first && d <= last;

  return {
    markers: overlay.markers.filter((m) => inside(m.date)),
    legs: overlay.legs.filter((l) => inside(l.fromDate) || inside(l.toDate)),
  };
}

/** True when this fill belongs to the currently selected trade. */
export function isFocused(focus: TradeFocus | null, tradeId: string): boolean {
  return focus != null && focus.tradeId === tradeId;
}

/** Opacity for a fill given the current selection (unselected fills recede). */
export function focusOpacity(focus: TradeFocus | null, tradeId: string): number {
  if (!focus) return 1;
  return focus.tradeId === tradeId ? 1 : 0.18;
}
