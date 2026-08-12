// Stamp-exempt instrument preference.
//
// A UK single stock pays 0.5% stamp duty on every BUY. That is 50bps of dead
// cost the position must earn back before the idea makes a penny, on top of
// commission and the half-spread. An LSE-listed UCITS ETF/ETC expressing a
// very similar view pays none of it.
//
// So when two ideas have comparable signal strength, the stamp-exempt one has
// a materially lower break-even. This module turns that into an explicit,
// configurable ranking preference: stamp-liable buys are ranked as though
// their stamp cost were counted a second time (scaled by the chosen level),
// and near-ties are broken in favour of the exempt instrument.
//
// Pure module: no I/O, no clock, safe to unit test.

import { UK_STAMP_DUTY_BPS } from "../trade-viability-gate";

export type StampExemptPreference = "off" | "balanced" | "strong";

export const STAMP_EXEMPT_PREFERENCE_LEVELS: StampExemptPreference[] = [
  "off",
  "balanced",
  "strong",
];

/** Neutral default: a mild tilt, never a ban on UK single stocks. */
export const DEFAULT_STAMP_EXEMPT_PREFERENCE: StampExemptPreference = "balanced";

/**
 * How much of the 50bps stamp charge is *re-counted* when ranking a
 * stamp-liable buy. 0 = cost model only, 1 = stamp effectively double-weighted.
 */
export function stampPreferenceWeight(level?: StampExemptPreference | null): number {
  switch (level) {
    case "strong":
      return 1;
    case "balanced":
      return 0.5;
    default:
      return 0;
  }
}

/**
 * Relative edge band inside which two candidates count as "comparable signal
 * strength". Within the band the stamp-exempt instrument wins outright.
 */
export const COMPARABLE_EDGE_BAND = 0.1;

/** Extra ranking-only cost (base currency) applied to a stamp-liable buy. */
export function stampPreferenceSurcharge(input: {
  notionalBase: number;
  stampLiable?: boolean | null;
  level?: StampExemptPreference | null;
}): number {
  if (!input.stampLiable) return 0;
  const notional = Math.max(0, Number(input.notionalBase) || 0);
  return (notional * UK_STAMP_DUTY_BPS * stampPreferenceWeight(input.level)) / 10_000;
}

/**
 * Break-even bps the ticket must earn back, given its real one-way cost. Used
 * for logging/telemetry so the preference is explainable: "prefer the ETF, its
 * break-even is 43bps vs 96bps".
 */
export function breakEvenBps(input: {
  notionalBase: number;
  estCostBase: number;
}): number {
  const notional = Math.max(0, Number(input.notionalBase) || 0);
  if (!(notional > 0)) return Infinity;
  return (Math.max(0, Number(input.estCostBase) || 0) / notional) * 10_000;
}

/**
 * True when `a` and `b` are close enough in edge that the cheaper-to-own
 * instrument should be preferred instead of the marginally stronger signal.
 */
export function edgesComparable(a: number, b: number, band = COMPARABLE_EDGE_BAND): boolean {
  const hi = Math.max(Math.abs(a), Math.abs(b));
  if (!(hi > 0)) return true;
  return Math.abs(a - b) / hi <= Math.max(0, band);
}
