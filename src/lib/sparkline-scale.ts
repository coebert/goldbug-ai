// Shared scaling for every "holding trend" sparkline in the app.
//
// Before this, each sparkline auto-scaled to its own raw min/max with zero
// padding, so the line touched the top and bottom edges of its box and two
// charts sitting next to each other used silently different rules. Both the
// axis-framed holdings charts and the compact inline sparklines now derive
// their domain here, so a given series always maps to the same geometry and
// the printed axis labels always match the drawn line.

export type SparklineDomain = {
  min: number;
  max: number;
  /** Bottom, middle and top gridline values (always min, mid, max). */
  ticks: [number, number, number];
};

/** Round a step to a 1 / 2 / 2.5 / 5 x 10^n "nice" value. */
function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const pow = Math.pow(10, exp);
  const frac = raw / pow;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return nice * pow;
}

/**
 * Standard domain for a price/value series.
 *
 * - pads by `padPct` of the range so the line never touches the frame,
 * - snaps the bounds outward to a nice step so the printed labels are round,
 * - keeps a sane band for a flat series (otherwise the line would sit on a
 *   zero-height axis and every tick would print the same number).
 */
export function sparklineDomain(
  values: number[],
  opts: { padPct?: number } = {},
): SparklineDomain {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return { min: 0, max: 1, ticks: [0, 0.5, 1] };

  const lo = Math.min(...clean);
  const hi = Math.max(...clean);
  const padPct = opts.padPct ?? 0.08;

  // Flat series: open a band around the value (1% of it, or 1 unit) so the
  // line renders mid-box instead of on the floor.
  const rawRange = hi - lo;
  const range = rawRange > 0 ? rawRange : Math.max(Math.abs(hi) * 0.01, 1);
  const pad = range * padPct;
  const step = niceStep((range + pad * 2) / 2);

  let min = Math.floor((lo - pad) / step) * step;
  let max = Math.ceil((hi + pad) / step) * step;
  if (max - min <= 0) {
    min = lo - range / 2;
    max = hi + range / 2;
  }
  // Never invent negative prices for a strictly positive series.
  if (lo >= 0 && min < 0) min = 0;

  const mid = (min + max) / 2;
  return { min, max, ticks: [min, mid, max] };
}
