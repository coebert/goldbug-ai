// Bounded override of the sector budget and single-name position cap for
// exceptionally strong, clearly profitable ideas.
//
// The concentration limits exist because a small account nibbled itself into
// accidental 30% positions. But they also blocked the rare idea the whole
// stack agrees on: very high conviction AND an expected move that clears its
// own round-trip friction many times over. Those ideas are the ones worth
// pressing, so they get a *stretched* cap — never an unlimited one.
//
// Pure and I/O-free.

/** Conviction (|unifiedScore|) an idea must reach to stretch the caps. */
export const OVERRIDE_MIN_CONVICTION = 0.85;

/** Expected gross edge must beat estimated round-trip friction by this much. */
export const OVERRIDE_EDGE_MULTIPLE = 6;

/** How far a cap may stretch for a qualifying idea. */
export const OVERRIDE_CAP_MULTIPLE = 1.5;

/** Absolute ceilings the stretch can never cross, as a fraction of NAV. */
export const OVERRIDE_MAX_SINGLE_NAME_PCT = 0.25;
export const OVERRIDE_MAX_DIVERSIFIED_PCT = 0.6;
export const OVERRIDE_MAX_SECTOR_PCT = 0.4;

export type OverrideInput = {
  /** Conviction in [0,1]; absent = neutral, never qualifies. */
  edgeScore?: number;
  /** Expected favourable move as a fraction of notional (0.04 = 4%). */
  expectedMovePct?: number;
  /** Ticket notional in base currency. */
  notionalBase: number;
  /** Estimated round-trip friction for this ticket, base currency. */
  estCostBase?: number;
};

/**
 * True when an idea is strong enough to stretch the concentration caps:
 * conviction at/above `OVERRIDE_MIN_CONVICTION` and expected gross edge at
 * least `OVERRIDE_EDGE_MULTIPLE` times its own estimated friction.
 */
export function qualifiesForCapOverride(c: OverrideInput): boolean {
  const conviction = Number.isFinite(c.edgeScore) ? Number(c.edgeScore) : 0;
  if (conviction < OVERRIDE_MIN_CONVICTION) return false;
  const move = Number.isFinite(c.expectedMovePct) ? Number(c.expectedMovePct) : 0.02;
  const notional = Math.max(0, Number(c.notionalBase) || 0);
  const grossEdge = conviction * move * notional;
  const cost = Math.max(0, Number(c.estCostBase) || 0);
  if (cost <= 0) return grossEdge > 0;
  return grossEdge >= OVERRIDE_EDGE_MULTIPLE * cost;
}

/** Stretch a cap fraction for a qualifying idea, bounded by a hard ceiling. */
export function stretchedCapPct(basePct: number, ceilingPct: number): number {
  const base = Math.max(0, basePct);
  return Math.max(base, Math.min(ceilingPct, base * OVERRIDE_CAP_MULTIPLE));
}
