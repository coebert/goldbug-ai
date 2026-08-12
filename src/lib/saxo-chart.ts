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

/**
 * Colour tokens. These resolve to the `--saxo-*` custom properties declared in
 * `src/styles.css`, so retuning the palette (or theming light/dark) never means
 * editing chart components.
 */
export const SAXO_COLOR = {
  up: "var(--saxo-up)",
  down: "var(--saxo-down)",
  grid: "var(--saxo-grid)",
  axis: "var(--saxo-axis)",
  crosshair: "var(--saxo-crosshair)",
  crosshairSoft: "var(--saxo-crosshair-soft)",
  reference: "var(--saxo-reference)",
  markerRing: "var(--saxo-marker-ring)",
  tooltip: "var(--saxo-tooltip)",
  tooltipForeground: "var(--saxo-tooltip-foreground)",
  tooltipBorder: "var(--saxo-tooltip-border)",
} as const;

/**
 * Numeric geometry and gradient opacities.
 *
 * These deliberately are NOT CSS variables: recharts writes them into SVG
 * presentation attributes (`r`, `stop-opacity`, `font-size`), which cannot
 * resolve `var()`. Tweak the Saxo look here; tweak its colours in styles.css.
 */
export const SAXO_METRIC = {
  tickFontSize: 11,
  tooltipFontSize: 12,
  tooltipRadius: 8,
  tickMargin: 8,
  strokeWidth: 2,
  hairlineWidth: 1,
  dotRadius: 2,
  activeDotRadius: 3.5,
  activeDotRingWidth: 1.5,
  haloRadius: 7,
  haloOpacity: 0.18,
  /** Zero-split fill: strong at the extremes, near-invisible at the zero line. */
  splitFillPeakOpacity: 0.45,
  splitFillTroughOpacity: 0.02,
  splitFillDownPeakOpacity: 0.4,
  /** Single-hue money fade. */
  fadeTopOpacity: 0.35,
  fadeBottomOpacity: 0,
} as const;


/** Faint, solid, horizontal-only gridlines. Spread onto <CartesianGrid />. */
export const SAXO_GRID = {
  stroke: SAXO_COLOR.grid,
  strokeDasharray: "0",
  vertical: false,
} as const;

/** Muted 11px tick label. */
export const SAXO_TICK = { fontSize: SAXO_METRIC.tickFontSize, fill: SAXO_COLOR.axis } as const;

/** Spread onto <XAxis /> / <YAxis />: naked axis, muted labels. */
export const SAXO_AXIS = {
  tick: SAXO_TICK,
  axisLine: false,
  tickLine: false,
  tickMargin: SAXO_METRIC.tickMargin,
} as const;

/** Zero/reference rule: solid and quiet, never competing with the series. */
export const SAXO_REFERENCE_LINE = {
  stroke: SAXO_COLOR.reference,
  strokeDasharray: "0",
} as const;

export const SAXO_TOOLTIP_CONTENT = {
  fontSize: SAXO_METRIC.tooltipFontSize,
  background: SAXO_COLOR.tooltip,
  border: `1px solid ${SAXO_COLOR.tooltipBorder}`,
  borderRadius: SAXO_METRIC.tooltipRadius,
  color: SAXO_COLOR.tooltipForeground,
  // Same phone-width cap as the generic tooltip surface: wrap long series
  // names instead of growing a panel that runs off the screen edge.
  maxWidth: "min(88vw, 20rem)",
  whiteSpace: "normal",
  overflowWrap: "anywhere",
} as const;

/** Legend styling for Saxo-themed charts; mirrors LEGEND_PROPS sizing. */
export const SAXO_LEGEND_PROPS = {
  wrapperStyle: {
    fontSize: "clamp(11px, 2.9vw, 12px)",
    lineHeight: 1.35,
    color: SAXO_COLOR.axis,
    width: "100%",
    maxHeight: "3.75rem",
    overflowY: "auto",
    paddingTop: 4,
  },
  iconSize: 9,
} as const;
export const SAXO_TOOLTIP_LABEL = { color: SAXO_COLOR.axis } as const;
export const SAXO_TOOLTIP_CURSOR = {
  stroke: SAXO_COLOR.crosshair,
  strokeWidth: SAXO_METRIC.hairlineWidth,
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
  return pointCount <= SAXO_DOT_LIMIT
    ? { r: SAXO_METRIC.dotRadius, fill: color, strokeWidth: 0 }
    : false;
}

export function saxoActiveDot(color: string) {
  return {
    r: SAXO_METRIC.activeDotRadius,
    fill: color,
    stroke: SAXO_COLOR.markerRing,
    strokeWidth: SAXO_METRIC.activeDotRingWidth,
  } as const;
}

/** Gradient stop tuples for a single-hue vertical fade (money series). */
export function fadeStops(color: string) {
  return [
    { offset: "0%", stopColor: color, stopOpacity: SAXO_METRIC.fadeTopOpacity },
    { offset: "100%", stopColor: color, stopOpacity: SAXO_METRIC.fadeBottomOpacity },
  ];
}

/**
 * Gradient stop tuples for a zero-split fill: green fading down to the zero
 * line, red fading away from it.
 */
export function splitFillStops(offset: number) {
  return [
    { offset: 0, stopColor: SAXO_COLOR.up, stopOpacity: SAXO_METRIC.splitFillPeakOpacity },
    { offset, stopColor: SAXO_COLOR.up, stopOpacity: SAXO_METRIC.splitFillTroughOpacity },
    { offset, stopColor: SAXO_COLOR.down, stopOpacity: SAXO_METRIC.splitFillTroughOpacity },
    { offset: 1, stopColor: SAXO_COLOR.down, stopOpacity: SAXO_METRIC.splitFillDownPeakOpacity },
  ];
}

/** Stroke gradient that flips hue exactly at the zero line. */
export function splitStrokeStops(offset: number) {
  return [
    { offset, stopColor: SAXO_COLOR.up },
    { offset, stopColor: SAXO_COLOR.down },
  ];
}
