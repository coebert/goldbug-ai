// ATR-based trailing stops (Phase 3).
//
// The idea: fixed-percentage stops are too tight in volatile regimes
// (whipsawed out) and too loose in calm regimes (giving back too much).
// Sizing the stop from the Average True Range makes it self-scaling —
// the leash widens when the tape is choppy and tightens when it isn't.
//
// Pure functions only. Callers supply OHLC bars in chronological order
// (oldest first). No I/O, no time source assumptions.

export type Bar = { high: number; low: number; close: number };

export type TrailingStopConfig = {
  atr_period: number;     // typical 14
  atr_multiple: number;   // typical 2.5–3.5; higher = looser leash
  min_stop_pct: number;   // safety floor (fractional, e.g. 0.005 = 0.5%)
  max_stop_pct: number;   // safety cap  (fractional, e.g. 0.15 = 15%)
};

export const DEFAULT_TRAILING_STOP: TrailingStopConfig = {
  atr_period: 14,
  atr_multiple: 3,
  min_stop_pct: 0.005,
  max_stop_pct: 0.15,
};

export type TrailingStopState = {
  entry_price: number;
  highest_since_entry: number;
  stop_price: number;
  atr: number;
  stop_pct: number;       // stop distance / current price
  triggered: boolean;
};

// Wilder's true range.
function trueRange(prev: Bar, cur: Bar): number {
  return Math.max(
    cur.high - cur.low,
    Math.abs(cur.high - prev.close),
    Math.abs(cur.low - prev.close),
  );
}

// Wilder's smoothed ATR. Returns null if not enough bars.
export function atr(bars: Bar[], period: number): number | null {
  if (bars.length < period + 1) return null;
  // Seed with a simple average of the first `period` TRs.
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trueRange(bars[i - 1], bars[i]);
  let a = sum / period;
  for (let i = period + 1; i < bars.length; i++) {
    const tr = trueRange(bars[i - 1], bars[i]);
    a = (a * (period - 1) + tr) / period;
  }
  return a;
}

// Compute a fresh trailing stop for a long position given the bar history
// since entry (entry bar first, most recent last).
export function computeTrailingStop(
  bars: Bar[],
  entryPrice: number,
  cfg: TrailingStopConfig = DEFAULT_TRAILING_STOP,
): TrailingStopState | null {
  if (bars.length === 0) return null;
  const last = bars[bars.length - 1];
  const a = atr(bars, cfg.atr_period);
  // Fall back to a min-floor stop while ATR is warming up.
  const price = last.close;
  const highest = bars.reduce((m, b) => Math.max(m, b.high), entryPrice);

  const rawDist = a !== null ? a * cfg.atr_multiple : price * cfg.min_stop_pct;
  const floorDist = price * cfg.min_stop_pct;
  const capDist = price * cfg.max_stop_pct;
  const dist = Math.min(capDist, Math.max(floorDist, rawDist));

  const stop = Math.max(entryPrice - capDist, highest - dist); // ratchet up, never down
  return {
    entry_price: entryPrice,
    highest_since_entry: highest,
    stop_price: stop,
    atr: a ?? 0,
    stop_pct: dist / price,
    triggered: price <= stop,
  };
}

// Advance an existing stop with one new bar without recomputing history.
// Keeps state monotonic: stop only ever moves up for a long.
export function advanceTrailingStop(
  prev: TrailingStopState,
  newBar: Bar,
  prevClose: number,
  cfg: TrailingStopConfig = DEFAULT_TRAILING_STOP,
): TrailingStopState {
  const period = Math.max(2, cfg.atr_period);
  const tr = trueRange({ high: 0, low: 0, close: prevClose }, newBar);
  const nextAtr = prev.atr > 0 ? (prev.atr * (period - 1) + tr) / period : tr;
  const highest = Math.max(prev.highest_since_entry, newBar.high);
  const price = newBar.close;
  const rawDist = nextAtr * cfg.atr_multiple;
  const dist = Math.min(price * cfg.max_stop_pct, Math.max(price * cfg.min_stop_pct, rawDist));
  const candidate = highest - dist;
  const stop = Math.max(prev.stop_price, candidate); // ratchet
  return {
    entry_price: prev.entry_price,
    highest_since_entry: highest,
    stop_price: stop,
    atr: nextAtr,
    stop_pct: dist / price,
    triggered: price <= stop,
  };
}
