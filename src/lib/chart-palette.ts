// Okabe–Ito color-blind-safe palette shared across charts.
// Each hue is distinguishable under protanopia, deuteranopia and
// tritanopia. Pair with non-color encodings (dashes, markers, text)
// whenever a chart carries semantic meaning.
//
// Reference: Okabe & Ito, "Color Universal Design (CUD)", 2008.
export const OKABE_ITO = {
  black: "#000000",
  orange: "#E69F00",
  skyBlue: "#56B4E9",
  bluishGreen: "#009E73",
  yellow: "#F0E442",
  blue: "#0072B2",
  vermillion: "#D55E00",
  reddishPurple: "#CC79A7",
} as const;

// Semantic role tokens. Prefer these over raw hex so meaning stays
// consistent across cards.
export const CHART_ROLE = {
  positive: OKABE_ITO.bluishGreen, // gains, buys, strategy P&L
  negative: OKABE_ITO.vermillion, // losses, sells, drawdown
  benchmark: OKABE_ITO.orange, // reference series (index, S&P)
  deposits: OKABE_ITO.blue, // capital in
  withdrawals: OKABE_ITO.orange,
  neutral: OKABE_ITO.skyBlue, // cash / carry
  highlight: OKABE_ITO.reddishPurple, // fees, div/interest, misc
  warning: OKABE_ITO.yellow,
} as const;

// Ordered sequence for series without semantic meaning (e.g. per-symbol
// stacks). Ordered to maximise adjacent-hue distance.
export const CHART_SEQUENCE: readonly string[] = [
  OKABE_ITO.blue,
  OKABE_ITO.orange,
  OKABE_ITO.bluishGreen,
  OKABE_ITO.reddishPurple,
  OKABE_ITO.skyBlue,
  OKABE_ITO.vermillion,
  OKABE_ITO.yellow,
] as const;

// Axis/tick styling. `--foreground` clears WCAG AA against both light
// and dark card surfaces; 12px is the smallest size that keeps AA
// legibility for numeric axes.
export const AXIS_TICK = { fontSize: 12, fill: "var(--foreground)" } as const;
export const AXIS_LABEL = { fontSize: 12, fill: "var(--foreground)" } as const;

// Legend text. Recharts renders legend labels with the browser's inherited
// colour, which resolves to black inside an SVG-adjacent wrapper — always
// pin it to the theme foreground.
//
// Sizing is viewport-responsive without a JS breakpoint: `clamp()` shrinks the
// label to 11px on a 360px phone and settles at 12px from ~460px up, and the
// wrapper is allowed to wrap onto a second row (with its own scroll ceiling)
// so a five-series legend can never push the plot area off the card or clip
// its last entry.
export const LEGEND_STYLE = {
  fontSize: "clamp(11px, 2.9vw, 12px)",
  lineHeight: 1.35,
  color: "var(--foreground)",
  width: "100%",
  maxHeight: "3.75rem",
  overflowY: "auto",
  paddingTop: 4,
} as const;

/**
 * Spread onto `<Legend {...LEGEND_PROPS} />`. Adds a smaller swatch to the
 * responsive text style: Recharts' 14px default icon plus its fixed gap is
 * what makes multi-series legends overflow first on a phone.
 */
export const LEGEND_PROPS = { wrapperStyle: LEGEND_STYLE, iconSize: 9 } as const;

// Tooltip surface. Recharts' built-in default is an opaque white panel with
// black text, which is unreadable against this app's dark theme.
export const TOOLTIP_CONTENT_STYLE = {
  fontSize: 12,
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--popover-foreground)",
  // A tooltip with several long series names renders as one very wide,
  // single-line panel that runs off a phone screen. Cap it against the
  // viewport and let long labels wrap instead of extending the panel.
  maxWidth: "min(88vw, 20rem)",
  whiteSpace: "normal",
  overflowWrap: "anywhere",
} as const;

/**
 * `wrapperStyle` for `<Tooltip>`: keeps the floating panel above sticky page
 * chrome and stops it from swallowing touches meant for the chart beneath.
 */
export const TOOLTIP_WRAPPER_STYLE = {
  zIndex: 30,
  maxWidth: "min(88vw, 20rem)",
  pointerEvents: "none",
} as const;
export const TOOLTIP_LABEL_STYLE = { color: "var(--muted-foreground)" } as const;
export const TOOLTIP_ITEM_STYLE = { color: "var(--popover-foreground)" } as const;

// ---------------------------------------------------------------------------
// Gridlines, axis lines and tick marks.
//
// Recharts' defaults are #ccc gridlines and #666 axis/tick lines, both of
// which are picked for a white page: on this app's dark plot surfaces the
// axis rules all but disappear while the grid glares. Derive every rule from
// `--foreground` so the same alpha ladder holds on any surface tier:
//
//   grid  ~14%  — structure you read past, never through
//   ticks ~50%  — short marks that need to register at 1px
//   axis  ~60%  — the frame itself; the strongest non-text rule
//
// The alphas are theme-agnostic because `--foreground` flips with the theme,
// but the *same* alpha yields lower contrast over a light surface than over a
// dark one (a light page has less headroom below its foreground). The ladder
// below is tuned against the weaker of the two: ticks/axis/reference all clear
// WCAG 1.4.11's 3:1 non-text bar on light surfaces down to ~oklch(0.94) as
// well as on `--surface-1`…`--surface-3` (enforced in
// chart-axis-readability.test.ts, both themes).
export const GRID_STROKE = "color-mix(in oklab, var(--foreground) 14%, transparent)";
export const AXIS_LINE_STROKE = "color-mix(in oklab, var(--foreground) 60%, transparent)";
export const TICK_LINE_STROKE = "color-mix(in oklab, var(--foreground) 50%, transparent)";


// Spread onto <CartesianGrid />. Dashed so gridlines stay distinguishable
// from plotted series at low alpha.
export const GRID_PROPS = {
  stroke: GRID_STROKE,
  strokeDasharray: "3 3",
} as const;

// Spread onto <XAxis /> / <YAxis /> alongside `tick={AXIS_TICK}`.
export const AXIS_LINE = { stroke: AXIS_LINE_STROKE } as const;
export const TICK_LINE = { stroke: TICK_LINE_STROKE } as const;
export const AXIS_PROPS = {
  tick: AXIS_TICK,
  axisLine: AXIS_LINE,
  tickLine: TICK_LINE,
} as const;

// Reference/baseline rules (zero lines, targets, thresholds). They sit above
// the grid but must never compete with a data series, so they land between
// the axis frame and the plotted colours. `--border` and `--muted-foreground`
// are NOT substitutes: both drop under 3:1 on `--surface-1`.
export const REFERENCE_LINE_STROKE = "color-mix(in oklab, var(--foreground) 75%, transparent)";
export const REFERENCE_LINE = {
  stroke: REFERENCE_LINE_STROKE,
  strokeDasharray: "3 3",
} as const;

// Neutral (non-semantic) series colour for supporting bands such as a cash
// sleeve or a win-rate backdrop. Deliberately low-chroma so Okabe–Ito hues
// stay dominant, but light enough to clear 3:1 on every dark surface —
// mid-slate greys such as #64748b do not.
export const CHART_NEUTRAL_SERIES = "#9AA4B2";

// Every colour a chart may paint a line, bar, area or reference rule with.
// The contrast suite iterates this list, so anything rendered in a chart
// must come from here rather than an inline literal.
export const CHART_SERIES_COLORS: readonly string[] = [
  ...new Set<string>([...Object.values(CHART_ROLE), ...CHART_SEQUENCE, CHART_NEUTRAL_SERIES]),
];
