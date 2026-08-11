// Phase 2 execution: broker-side protective stops.
//
// App-side stops only fire when the hourly run happens to be awake and the
// broker session is healthy. A stop resting *at the broker* survives outages,
// weekends and overnight gaps, which is exactly when the damage happens.
//
// Pure module: given a fill and a volatility estimate, produce the stop price
// (and whether a stop is warranted at all).

export type ProtectiveStopInput = {
  side: "buy" | "sell";
  /** Average fill price in the instrument's own quote units. */
  fillPrice: number;
  /** 14d ATR as a fraction of price (0.02 = 2%), when known. */
  atrPct?: number | null;
  /** ATR multiple for the stop distance. Default 2.5. */
  atrMult?: number;
  /** Floor / ceiling on the stop distance, in percent of price. */
  minStopPct?: number;
  maxStopPct?: number;
  /** Quote tick size in the same units as `fillPrice`. */
  tickSize?: number;
};

export type ProtectiveStopPlan = {
  /** Side of the protective order (opposite of the entry). */
  side: "buy" | "sell";
  stopPrice: number;
  stopPct: number;
  reason: string;
};

const DEFAULTS = {
  atrMult: 2.5,
  minStopPct: 0.03,
  maxStopPct: 0.15,
  fallbackAtrPct: 0.02,
};

function roundToTick(price: number, tickSize: number | undefined, side: "buy" | "sell"): number {
  if (!tickSize || !(tickSize > 0) || !Number.isFinite(tickSize)) return price;
  const n = price / tickSize;
  // Protective sell rounds down (trigger slightly further away → less whipsaw);
  // protective buy-to-cover rounds up.
  const rounded = side === "sell" ? Math.floor(n) : Math.ceil(n);
  return Math.max(tickSize, rounded * tickSize);
}

export function planProtectiveStop(input: ProtectiveStopInput): ProtectiveStopPlan | null {
  const px = Number(input.fillPrice);
  if (!Number.isFinite(px) || px <= 0) return null;

  const atrPct =
    Number.isFinite(input.atrPct ?? NaN) && (input.atrPct as number) > 0
      ? (input.atrPct as number)
      : DEFAULTS.fallbackAtrPct;
  const mult = input.atrMult ?? DEFAULTS.atrMult;
  const minPct = input.minStopPct ?? DEFAULTS.minStopPct;
  const maxPct = input.maxStopPct ?? DEFAULTS.maxStopPct;

  const stopPct = Math.min(maxPct, Math.max(minPct, atrPct * mult));
  // A long entry is protected by a sell stop below; a short (cash-funded
  // inverse ETF is still a long, so this only fires on genuine sells) by a
  // buy stop above.
  const side: "buy" | "sell" = input.side === "buy" ? "sell" : "buy";
  const raw = side === "sell" ? px * (1 - stopPct) : px * (1 + stopPct);
  const stopPrice = roundToTick(raw, input.tickSize, side);

  return {
    side,
    stopPrice,
    stopPct,
    reason:
      `protective ${side} stop ${(stopPct * 100).toFixed(1)}% ` +
      `(${atrPct === DEFAULTS.fallbackAtrPct ? "default" : "ATR"} ${(atrPct * 100).toFixed(1)}% × ${mult})`,
  };
}
