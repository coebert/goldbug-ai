// Phase 3 item 15 — single combined multiplier ceiling.
//
// The buy sizer stacks several *boosts* (alpha × conviction, sector cycle
// phase, breakout regime, conviction scaling). Individually each is capped;
// multiplied together they were able to push a ticket well past any single
// cap's intent. This module combines them, caps the product, and names the
// factor that bound so the audit trail can explain the size.
//
// Haircuts (multipliers < 1) belong in sizing-haircuts.ts — this module
// only handles the upside.

export type Boost = {
  /** Short label for the audit trail, e.g. "alpha×conv". */
  label: string;
  /** Multiplier >= 1. Values <= 1 are ignored. */
  mult: number;
};

export type BoostResult = {
  /** Combined multiplier in [1, ceiling]. */
  mult: number;
  /** Naive product before the ceiling. */
  rawProduct: number;
  /** True when the ceiling bound. */
  capped: boolean;
  /** Label of the single largest contributing boost, or null. */
  binding: string | null;
  /** Boosts that were applied, largest first. */
  applied: Boost[];
  /** Human-readable sizing note, or null when nothing applied. */
  note: string | null;
};

/** No stack of boosts may more than double the intended ticket. */
export const BOOST_CEILING = 1.8;

export function combineBoosts(
  boosts: Array<Boost | null | undefined>,
  opts?: { ceiling?: number },
): BoostResult {
  const ceiling = Math.max(1, opts?.ceiling ?? BOOST_CEILING);
  const applied = boosts
    .filter((b): b is Boost => !!b && Number.isFinite(b.mult) && b.mult > 1)
    .map((b) => ({ label: b.label, mult: b.mult }))
    .sort((a, b) => b.mult - a.mult);

  if (applied.length === 0) {
    return { mult: 1, rawProduct: 1, capped: false, binding: null, applied: [], note: null };
  }

  const rawProduct = applied.reduce((acc, b) => acc * b.mult, 1);
  const mult = Math.min(ceiling, rawProduct);
  const capped = rawProduct > ceiling + 1e-9;
  const binding = capped ? "ceiling" : (applied[0]?.label ?? null);

  const note =
    `boosts ${applied.map((b) => `${b.label}×${b.mult.toFixed(2)}`).join(" ")}` +
    ` → ×${mult.toFixed(2)}` +
    (capped ? ` (capped from ×${rawProduct.toFixed(2)})` : "");

  return { mult, rawProduct, capped, binding, applied, note };
}
