// Coordinated sizing-haircut aggregation.
//
// The buy sizer used to apply ~10 independent multipliers sequentially
// (`spend *= m`). Each one looks mild in isolation, but they compound:
// three 0.5× haircuts leave 12.5% of the intended ticket, which is how
// tickets ended up too small to clear the fee floor.
//
// This module collects haircuts and combines them with *diminishing
// marginal severity*: the most severe haircut applies in full, and each
// subsequent one contributes a damped share of its shortfall. The result
// is floored so no stack of soft signals can wipe out a trade — a hard
// block must be an explicit rejection, not an accidental product of
// multipliers.
//
// Hard caps (per-symbol room, class caps, gross exposure, cash) are NOT
// haircuts and must still be applied with `Math.min` after this runs.

/** Weight applied to the i-th most severe haircut's shortfall. */
const DAMPING = 0.65;

/** Combined haircut never takes a trade below this share of intended size. */
export const HAIRCUT_FLOOR = 0.35;

export type Haircut = {
  /** Short label for the sizing-notes trail, e.g. "fear62". */
  label: string;
  /** Multiplier in (0, 1]. Values >= 1 are ignored. */
  mult: number;
};

export type HaircutResult = {
  /** Combined multiplier in [HAIRCUT_FLOOR, 1]. */
  mult: number;
  /** Naive sequential product, for telemetry and explanation. */
  rawProduct: number;
  /** True when the floor bound, i.e. the raw product was more severe. */
  floored: boolean;
  /** Applied haircuts, most severe first. */
  applied: Haircut[];
  /** Human-readable sizing note, or null when nothing applied. */
  note: string | null;
};

/**
 * Combine soft sizing haircuts with diminishing marginal severity.
 *
 * The most severe haircut is honoured in full; the next contributes 65%
 * of its shortfall, the next 42%, and so on. The product is then floored
 * at `HAIRCUT_FLOOR`.
 */
export function combineHaircuts(
  haircuts: Array<Haircut | null | undefined>,
  opts?: { floor?: number },
): HaircutResult {
  const floor = Math.max(0, Math.min(1, opts?.floor ?? HAIRCUT_FLOOR));
  const applied = haircuts
    .filter((h): h is Haircut => !!h && Number.isFinite(h.mult) && h.mult < 1)
    .map((h) => ({ label: h.label, mult: Math.max(0, h.mult) }))
    .sort((a, b) => a.mult - b.mult);

  if (applied.length === 0) {
    return { mult: 1, rawProduct: 1, floored: false, applied: [], note: null };
  }

  let rawProduct = 1;
  let damped = 1;
  applied.forEach((h, i) => {
    rawProduct *= h.mult;
    const shortfall = 1 - h.mult;
    damped *= 1 - shortfall * Math.pow(DAMPING, i);
  });

  const mult = Math.max(floor, damped);
  const note =
    `haircuts ${applied.map((h) => `${h.label}×${h.mult.toFixed(2)}`).join(" ")}` +
    ` → ×${mult.toFixed(2)}` +
    (mult > rawProduct + 1e-9 ? ` (compounded ×${rawProduct.toFixed(2)}, damped)` : "");

  return { mult, rawProduct, floored: damped < floor, applied, note };
}
