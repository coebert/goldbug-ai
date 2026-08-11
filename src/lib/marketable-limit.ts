// Phase 2 execution: marketable limit orders.
//
// Plain market orders hand the whole spread (and any momentary gap) to the
// venue. A *marketable* limit still crosses the book — so it fills like a
// market order in normal conditions — but caps the worst price we accept.
// If the book has run away from our reference price, the order simply doesn't
// fill instead of printing 200bps through the touch.
//
// Pure module: no IO, no broker types. Price units are whatever the caller
// passes in (GBX or GBP), because the cap is multiplicative.

import { estimateSpreadSlippage } from "./spread-slippage";

/** Asset class label as used by the spread model ("stock" | "etf" | ...). */
export type MarketableAssetClass = string;

export type MarketableLimitInput = {
  side: "buy" | "sell";
  /** Reference (last/mid) price in the instrument's own quote units. */
  referencePrice: number;
  /** Optional asset class + currency to size the half-spread realistically. */
  assetClass?: MarketableAssetClass;
  currency?: string;
  /** Recent ATR as a fraction of price (0.02 = 2%), if known. */
  atrPct?: number;
  /** How many half-spreads to cross beyond the touch. Default 2 (≈ full spread of slack). */
  crossHalfSpreads?: number;
  /** Hard ceiling on the slack, in bps. Default 60bps. */
  maxSlackBps?: number;
  /** Floor on the slack so tiny modelled spreads still fill. Default 8bps. */
  minSlackBps?: number;
  /** Ticket notional, used to size the impact/spread estimate. */
  notional?: number;
  /** Quote tick size in the same units as `referencePrice`. */
  tickSize?: number;
};

export type MarketableLimitPlan = {
  /** Limit price to send, rounded to the tick in the conservative direction. */
  limitPrice: number;
  /** Slack applied versus the reference, in bps. */
  slackBps: number;
  /** Modelled one-side half-spread used to derive the slack. */
  halfSpreadBps: number;
  reason: string;
};

const DEFAULTS = {
  crossHalfSpreads: 2,
  maxSlackBps: 60,
  minSlackBps: 8,
};

/** Round to a tick, in the direction that keeps the order marketable. */
function roundToTick(price: number, tickSize: number | undefined, side: "buy" | "sell"): number {
  if (!tickSize || !(tickSize > 0) || !Number.isFinite(tickSize)) return price;
  const n = price / tickSize;
  const rounded = side === "buy" ? Math.ceil(n) : Math.floor(n);
  return Math.max(tickSize, rounded * tickSize);
}

export function planMarketableLimit(input: MarketableLimitInput): MarketableLimitPlan | null {
  const ref = Number(input.referencePrice);
  if (!Number.isFinite(ref) || ref <= 0) return null;

  const crossHalfSpreads = input.crossHalfSpreads ?? DEFAULTS.crossHalfSpreads;
  const maxSlackBps = input.maxSlackBps ?? DEFAULTS.maxSlackBps;
  const minSlackBps = input.minSlackBps ?? DEFAULTS.minSlackBps;

  let halfSpreadBps = 0;
  try {
    const est = estimateSpreadSlippage({
      assetClass: (input.assetClass ?? "stock") as never,
      notional: input.notional ?? 1000,
      ...(input.currency ? { currency: input.currency } : {}),
      ...(input.atrPct != null ? { atrPct: input.atrPct } : {}),
      urgency: "normal",
    } as Parameters<typeof estimateSpreadSlippage>[0]);
    halfSpreadBps = Number(est.halfSpreadBps) || 0;
  } catch {
    halfSpreadBps = 0;
  }

  const slackBps = Math.min(
    maxSlackBps,
    Math.max(minSlackBps, halfSpreadBps * Math.max(0, crossHalfSpreads)),
  );

  const raw =
    input.side === "buy" ? ref * (1 + slackBps / 10_000) : ref * (1 - slackBps / 10_000);
  const limitPrice = roundToTick(raw, input.tickSize, input.side);

  return {
    limitPrice,
    slackBps,
    halfSpreadBps,
    reason:
      `marketable limit: ${input.side} ${slackBps.toFixed(1)}bps ` +
      `${input.side === "buy" ? "above" : "below"} ${ref} ` +
      `(half-spread ${halfSpreadBps.toFixed(1)}bps × ${crossHalfSpreads})`,
  };
}
