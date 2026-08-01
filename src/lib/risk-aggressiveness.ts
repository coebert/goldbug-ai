// Risk-dial → sizing / trade-aggressiveness resolution.
//
// The 1..5 dial does two distinct things:
//   * position sizing — how much capital a single buy is allowed to deploy;
//   * trade aggressiveness — how much of the *wanted* change (the gap between
//     current and target exposure) is taken in one go, on each side.
//
// Buys and sells are tuned separately on purpose: a defensive profile buys
// slowly but exits fast, an aggressive one does the reverse. Everything here
// is pure and clamped so an out-of-range stored value can never inflate risk.

import { RISK_PRESETS } from "./risk-presets";

export type Aggressiveness = {
  /** Dial position this was derived from (1..5). */
  level: number;
  /** Human label, e.g. "Balanced". */
  name: string;
  /** Multiplier applied to every buy budget. */
  sizeMult: number;
  /** Fraction of a wanted buy taken in one pass. */
  buy: number;
  /** Fraction of a wanted trim taken in one pass. */
  sell: number;
  /** Drift band before a rebalance bothers trading, as a fraction of NAV. */
  driftBand: number;
};

/** Hard bounds — a stored config can never push sizing outside these. */
export const AGGRESSIVENESS_BOUNDS = { min: 0.25, max: 1.5 } as const;
export const SIZE_MULT_BOUNDS = { min: 0.25, max: 2 } as const;

export function clampRange(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function clampDialLevel(v: unknown): number {
  const n = Math.round(typeof v === "number" ? v : Number(v));
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n));
}

/**
 * A patient dial trades in smaller slices, so it also tolerates more drift
 * before touching a position; an aggressive dial rebalances on thinner gaps.
 */
function driftBandFor(level: number): number {
  return [0.02, 0.015, 0.01, 0.0075, 0.005][clampDialLevel(level) - 1];
}

/**
 * Resolve the effective sizing/aggressiveness knobs from a stored
 * `risk_config`. Explicit per-field overrides win over the preset, which in
 * turn wins over the balanced default.
 */
export function resolveAggressiveness(riskConfig: unknown, fallbackLevel = 3): Aggressiveness {
  const raw = (riskConfig && typeof riskConfig === "object" ? riskConfig : {}) as Record<
    string,
    unknown
  >;
  const level = clampDialLevel(raw.risk_level ?? fallbackLevel);
  const preset = (RISK_PRESETS[level] ?? RISK_PRESETS[3]).cfg;

  return {
    level,
    name: (RISK_PRESETS[level] ?? RISK_PRESETS[3]).name,
    sizeMult: clampRange(
      raw.size_multiplier ?? preset.size_multiplier,
      SIZE_MULT_BOUNDS.min,
      SIZE_MULT_BOUNDS.max,
      1,
    ),
    buy: clampRange(
      raw.buy_aggressiveness ?? preset.buy_aggressiveness,
      AGGRESSIVENESS_BOUNDS.min,
      AGGRESSIVENESS_BOUNDS.max,
      0.8,
    ),
    sell: clampRange(
      raw.sell_aggressiveness ?? preset.sell_aggressiveness,
      AGGRESSIVENESS_BOUNDS.min,
      AGGRESSIVENESS_BOUNDS.max,
      1,
    ),
    driftBand: driftBandFor(level),
  };
}

/** Buy budget after sizing + buy-side aggressiveness, never negative. */
export function aggressiveBuySpend(baseSpend: number, a: Aggressiveness): number {
  if (!Number.isFinite(baseSpend) || baseSpend <= 0) return 0;
  return baseSpend * a.sizeMult * a.buy;
}

/**
 * Sell quantity after sell-side aggressiveness. Clamped to the held quantity
 * so an aggressiveness above 1 can accelerate an exit but never short.
 */
export function aggressiveSellQty(baseQty: number, heldQty: number, a: Aggressiveness): number {
  if (!Number.isFinite(baseQty) || baseQty <= 0) return 0;
  const held = Number.isFinite(heldQty) && heldQty > 0 ? heldQty : 0;
  return Math.min(held, baseQty * a.sell);
}
