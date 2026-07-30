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
export const LEGEND_STYLE = { fontSize: 12, color: "var(--foreground)" } as const;

// Tooltip surface. Recharts' built-in default is an opaque white panel with
// black text, which is unreadable against this app's dark theme.
export const TOOLTIP_CONTENT_STYLE = {
  fontSize: 12,
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--popover-foreground)",
} as const;
export const TOOLTIP_LABEL_STYLE = { color: "var(--muted-foreground)" } as const;
export const TOOLTIP_ITEM_STYLE = { color: "var(--popover-foreground)" } as const;
