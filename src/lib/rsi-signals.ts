// RSI zone entry/exit markers for the symbol chart.
//
// Two schools of thought, both offered as options:
//   - "touch"  : act the moment RSI enters the zone (RSI <= 30 => buy signal).
//                Early, catches the low, but keeps firing into a falling knife.
//   - "cross"  : wait for RSI to leave the zone again (RSI back above 30 after
//                being oversold => buy). Later entry, fewer false starts.
//
// Both modes emit at most one marker per zone episode, so a symbol sitting at
// RSI 25 for a fortnight produces one buy marker, not fourteen.

import {
  RSI_OVERBOUGHT,
  RSI_OVERSOLD,
  type HistoryPoint,
} from "./market-symbol-history";

export type RsiSignalMode = "cross" | "touch";
export type RsiSignalKind = "buy" | "sell";

export interface RsiSignal {
  kind: RsiSignalKind;
  /** ISO date of the bar carrying the marker. */
  date: string;
  /** Close on that bar, used to place the marker on the price chart. */
  price: number;
  /** RSI on that bar, used to place the marker on the RSI pane. */
  rsi: number;
  mode: RsiSignalMode;
}

export const RSI_SIGNAL_MODES: RsiSignalMode[] = ["cross", "touch"];

export const RSI_SIGNAL_MODE_LABEL: Record<RsiSignalMode, string> = {
  cross: "Cross",
  touch: "Touch",
};

export const RSI_SIGNAL_MODE_HINT: Record<RsiSignalMode, string> = {
  cross: `Marks the bar RSI climbs back above ${RSI_OVERSOLD} (buy) or drops back below ${RSI_OVERBOUGHT} (sell) — confirmation over speed.`,
  touch: `Marks the first bar RSI reaches ${RSI_OVERSOLD} (buy) or ${RSI_OVERBOUGHT} (sell) — earliest signal, more false starts.`,
};

export function isRsiSignalMode(value: unknown): value is RsiSignalMode {
  return value === "cross" || value === "touch";
}

/**
 * Detect buy/sell markers from the RSI series on a window of history.
 * Bars without RSI (the warm-up period) are skipped without breaking the
 * episode state, so a data gap cannot manufacture a fake re-entry.
 */
export function detectRsiSignals(
  points: HistoryPoint[],
  mode: RsiSignalMode,
  opts: { oversold?: number; overbought?: number } = {},
): RsiSignal[] {
  const oversold = opts.oversold ?? RSI_OVERSOLD;
  const overbought = opts.overbought ?? RSI_OVERBOUGHT;
  const signals: RsiSignal[] = [];

  // Whether we are currently inside each zone episode.
  let inOversold = false;
  let inOverbought = false;
  let seeded = false;

  for (const p of points) {
    const rsi = p.rsi14;
    if (rsi == null || !Number.isFinite(rsi) || !Number.isFinite(p.close)) continue;

    const nowOversold = rsi <= oversold;
    const nowOverbought = rsi >= overbought;

    if (!seeded) {
      // First readable bar only establishes state: we cannot know whether it
      // was an entry or a continuation from before the window.
      inOversold = nowOversold;
      inOverbought = nowOverbought;
      seeded = true;
      continue;
    }

    if (mode === "touch") {
      if (nowOversold && !inOversold) {
        signals.push({ kind: "buy", date: p.date, price: p.close, rsi, mode });
      }
      if (nowOverbought && !inOverbought) {
        signals.push({ kind: "sell", date: p.date, price: p.close, rsi, mode });
      }
    } else {
      if (!nowOversold && inOversold) {
        signals.push({ kind: "buy", date: p.date, price: p.close, rsi, mode });
      }
      if (!nowOverbought && inOverbought) {
        signals.push({ kind: "sell", date: p.date, price: p.close, rsi, mode });
      }
    }

    inOversold = nowOversold;
    inOverbought = nowOverbought;
  }

  return signals;
}

/** One-line plain-language description of a marker. */
export function rsiSignalSummary(
  s: RsiSignal,
  opts: { oversold?: number; overbought?: number } = {},
): string {
  const oversold = opts.oversold ?? RSI_OVERSOLD;
  const overbought = opts.overbought ?? RSI_OVERBOUGHT;
  if (s.mode === "touch") {
    return s.kind === "buy"
      ? `RSI reached ${s.rsi.toFixed(0)} (oversold below ${oversold})`
      : `RSI reached ${s.rsi.toFixed(0)} (overbought above ${overbought})`;
  }
  return s.kind === "buy"
    ? `RSI recovered to ${s.rsi.toFixed(0)}, back above ${oversold}`
    : `RSI cooled to ${s.rsi.toFixed(0)}, back below ${overbought}`;
}
