// Size-aware measured cost floor.
//
// The account's fill-measured round-trip cost (~90bps) is a *ratio*, and it was
// measured on the tickets this book actually places — small ones, near the £250
// viable floor. A large part of that ratio is the broker's per-side minimum
// commission, which is a fixed number of pounds, not a rate. Applying the flat
// ratio to every candidate therefore punished exactly the trades that fix the
// problem: doubling a ticket halves the fixed-fee drag in bps, but the old gate
// still charged it the same 90bps, so no size-up could ever clear the hurdle
// and ideas were rejected that would have been comfortably profitable.
//
// This module splits the measured figure into the part that scales with size
// (spread, slippage, ad-valorem commission, stamp) and the part that does not
// (the commission minimum, twice), then re-prices it at the notional actually
// being considered.
//
// Pure: no IO, no broker, no database.

import { estimateSaxoCommission } from "./saxo-fees";

/**
 * Notional the account's measured cost is assumed to have been sampled at, in
 * the instrument's own currency. Matches the governor's absolute minimum
 * ticket (`VIABLE_TICKET_FLOOR_MAJOR`), which is the smallest ticket included
 * in the measurement.
 */
export const DEFAULT_MEASURED_TICKET_NOTIONAL = 250;

/** Never re-price the measured floor beyond this multiple of itself. */
const MAX_SCALE = 3;

export type MeasuredFloorInput = {
  symbol: string;
  assetClass?: string | null;
  /** Fill-measured round trip, bps of notional. */
  measuredRoundTripBps: number;
  /** Notional the measurement reflects (instrument currency). */
  measuredAtNotional?: number;
  /** Notional being considered now (instrument currency). */
  notional: number;
};

export type MeasuredFloorParts = {
  /** Portion of the measured cost that scales with ticket size, in bps. */
  variableBps: number;
  /** Fixed per-round-trip commission minimum, instrument currency. */
  fixedCost: number;
};

function fixedRoundTripCost(symbol: string, assetClass?: string | null): number {
  // Commission at zero notional is the per-side minimum: the size-invariant
  // part of the bill, paid on the way in and again on the way out.
  const floor = estimateSaxoCommission({
    notional: 0,
    symbol,
    assetClass: (assetClass ?? "stock") as never,
  }).commission;
  return 2 * Math.max(0, floor);
}

/** Split a measured round-trip ratio into its size-invariant and rate parts. */
export function measuredFloorParts(input: {
  symbol: string;
  assetClass?: string | null;
  measuredRoundTripBps: number;
  measuredAtNotional?: number;
}): MeasuredFloorParts {
  const measured = Math.max(0, Number(input.measuredRoundTripBps) || 0);
  const at = Math.max(1, Number(input.measuredAtNotional) || DEFAULT_MEASURED_TICKET_NOTIONAL);
  const fixedCost = fixedRoundTripCost(input.symbol, input.assetClass);
  const fixedBpsAtMeasure = (fixedCost * 10_000) / at;
  return {
    variableBps: Math.max(0, measured - fixedBpsAtMeasure),
    fixedCost,
  };
}

/**
 * The measured cost floor re-expressed at a given ticket size. Bigger tickets
 * dilute the fixed commission; smaller ones concentrate it.
 */
export function scaleMeasuredRoundTripBps(input: MeasuredFloorInput): number {
  const measured = Math.max(0, Number(input.measuredRoundTripBps) || 0);
  if (!(measured > 0)) return 0;
  const notional = Number(input.notional);
  if (!Number.isFinite(notional) || notional <= 0) return measured;
  const { variableBps, fixedCost } = measuredFloorParts(input);
  const scaled = variableBps + (fixedCost * 10_000) / notional;
  return Math.min(measured * MAX_SCALE, Math.max(variableBps, scaled));
}

/**
 * Smallest notional at which the measured floor fits a bps budget. Infinite
 * when the size-invariant part alone already blows the budget — no amount of
 * sizing up rescues an idea whose spread and slippage exceed its edge.
 */
export function minNotionalForMeasuredFloor(input: {
  symbol: string;
  assetClass?: string | null;
  measuredRoundTripBps: number;
  measuredAtNotional?: number;
  budgetBps: number;
}): number {
  const measured = Math.max(0, Number(input.measuredRoundTripBps) || 0);
  if (!(measured > 0)) return 0;
  const { variableBps, fixedCost } = measuredFloorParts(input);
  const slack = Number(input.budgetBps) - variableBps;
  if (!(slack > 0)) return Infinity;
  if (!(fixedCost > 0)) return 0;
  return (fixedCost * 10_000) / slack;
}
