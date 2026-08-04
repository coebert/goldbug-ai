/**
 * Shared "Saxo" chart visual system.
 *
 * The house style, taken from the Saxo mobile app and first implemented in
 * `equity-pct-chart.tsx`:
 *   - one calm gradient-filled curve rather than competing series decorations
 *   - the fill/stroke flip colour at the zero line (green above, red below)
 *   - faint horizontal-only gridlines, no vertical rules, no tick marks
 *   - sparse x labels (first and last only when the span is self-evident)
 *   - small point markers on short series; detail moves into the tooltip
 *
 * Every chart in the app should import these tokens rather than re-deriving
 * axis/grid/tooltip styling, so the look stays identical card to card.
 */

/** Faint, solid, horizontal-only gridlines. Spread onto <CartesianGrid />. */
export const SAXO_GRID = {
  stroke: "color-mix(in oklab, var(--foreground) 14%, transparent)",
  strokeDasharray: "0",
  vertical: false,
} as const;

/** Muted 11px tick label. */
export const SAXO_TICK = { fontSize: 11, fill: "var(--muted-foreground)" } as const;

/** Spread onto <XAxis /> / <YAxis />: naked axis, muted labels. */
export const SAXO_AXIS = {
  tick: SAXO_TICK,
  axisLine: false,
  tickLine: false,
  tickMargin: 8,
} as const;

/** Zero/reference rule: solid and quiet, never competing with the series. */
export const SAXO_REFERENCE_LINE = {
  stroke: "color-mix(in oklab, var(--foreground) 45%, transparent)",
  strokeDasharray: "0",
} as const;

export const SAXO_TOOLTIP_CONTENT = {
  fontSize: 12,
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--popover-foreground)",
} as const;
export const SAXO_TOOLTIP_LABEL = { color: "var(--muted-foreground)" } as const;
export const SAXO_TOOLTIP_CURSOR = {
  stroke: "var(--muted-foreground)",
  strokeWidth: 1,
  strokeDasharray: "3 3",
} as const;

/**
 * Where zero sits inside a [min, max] y-domain, as a 0..1 offset measured from
 * the *top* of the plot — the coordinate space SVG gradient stops use.
 *
 * Clamped so an all-positive or all-negative series still produces a valid
 * gradient (0 or 1) instead of an out-of-range stop that browsers ignore.
 */
export function zeroOffset(domain: [number, number]): number {
  const [lo, hi] = domain;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) return 1;
  return Math.min(1, Math.max(0, hi / (hi - lo)));
}

/**
 * First and last x values only. Saxo shows the window edges and lets the
 * tooltip carry per-point dates, which keeps dense series legible on mobile.
 */
export function edgeTicks<T extends Record<string, unknown>>(
  rows: T[],
  key: keyof T,
): Array<T[keyof T]> {
  if (rows.length === 0) return [];
  if (rows.length === 1) return [rows[0][key]];
  return [rows[0][key], rows[rows.length - 1][key]];
}

/** Point markers only while they can breathe; past ~40 points they smear. */
export const SAXO_DOT_LIMIT = 40;

export function saxoDot(color: string, pointCount: number) {
  return pointCount <= SAXO_DOT_LIMIT ? { r: 2, fill: color, strokeWidth: 0 } : false;
}

export function saxoActiveDot(color: string) {
  return { r: 3.5, fill: color, stroke: "var(--background)", strokeWidth: 1.5 } as const;
}

/** Gradient stop tuples for a single-hue vertical fade (money series). */
export function fadeStops(color: string) {
  return [
    { offset: "0%", stopColor: color, stopOpacity: 0.35 },
    { offset: "100%", stopColor: color, stopOpacity: 0 },
  ];
}

/**
 * Gradient stop tuples for a zero-split fill: green fading down to the zero
 * line, red fading away from it.
 */
export function splitFillStops(offset: number) {
  return [
    { offset: 0, stopColor: "var(--success)", stopOpacity: 0.45 },
    { offset, stopColor: "var(--success)", stopOpacity: 0.02 },
    { offset, stopColor: "var(--destructive)", stopOpacity: 0.02 },
    { offset: 1, stopColor: "var(--destructive)", stopOpacity: 0.4 },
  ];
}

/** Stroke gradient that flips hue exactly at the zero line. */
export function splitStrokeStops(offset: number) {
  return [
    { offset, stopColor: "var(--success)" },
    { offset, stopColor: "var(--destructive)" },
  ];
}
