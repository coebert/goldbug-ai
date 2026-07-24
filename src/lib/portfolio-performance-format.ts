// Pure formatters and label metadata for the portfolio performance
// chart. Owning these here (instead of inline in the route) lets us
// lock the on-screen text down with a visual-regression snapshot
// test — any change to a tick label, tooltip line, or metric row
// label will fail the snapshot before it can silently ship.
//
// The route imports these helpers directly, so the snapshot is the
// authoritative contract for what the chart renders.

export function shortChartDate(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

export function compactChartNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000) return `${(v / 1_000).toFixed(a >= 10_000 ? 0 : 1)}k`;
  return `${v.toFixed(0)}`;
}

/** X-axis tick — desktop shows the raw ISO string, mobile shortens it. */
export function formatDateTick(value: unknown, isMobile: boolean): string {
  const s = String(value);
  return isMobile ? shortChartDate(s) : s;
}

/**
 * Y-axis tick. In pct mode we render a signed integer percentage;
 * in raw mode we prefix the currency and use a compact number on
 * mobile so the axis doesn't push the plot area off screen.
 */
export function formatValueTick(
  value: unknown,
  opts: { currency: string; isPct: boolean; isMobile: boolean },
): string {
  const n = Number(value);
  if (opts.isPct) {
    const sign = n >= 0 ? "+" : "";
    return `${sign}${n.toFixed(0)}%`;
  }
  return opts.isMobile
    ? `${opts.currency}${compactChartNum(n)}`
    : `${opts.currency}${n.toFixed(0)}`;
}

/** Tooltip "Portfolio: …" / benchmark line formatter. */
export function formatTooltipValue(
  value: number,
  opts: { currency: string; isPct: boolean },
): string {
  if (opts.isPct) {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
  }
  return `${opts.currency} ${value.toFixed(2)}`;
}

/** Signed percentage — used for "vs start" and benchmark delta lines. */
export function formatSignedPct(value: number, digits = 2): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

/** Signed number — used for PnL lines beside the tooltip. */
export function formatSignedNum(value: number, digits = 2): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}`;
}

/**
 * Metric-tile formatter shared by the CAGR/Sharpe/... hero grid and
 * the per-column "Performance vs benchmark" grid. Returns "—" for
 * missing/non-finite values so the layout never breaks.
 */
export function formatMetric(
  value: number | null | undefined,
  opts: { signed: boolean; suffix: string; digits?: number },
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = opts.signed && value > 0 ? "+" : "";
  return `${sign}${value.toFixed(opts.digits ?? 2)}${opts.suffix}`;
}

// ---------------------------------------------------------------------------
// Label metadata. Kept as data so the snapshot test can iterate the
// exact strings the UI renders without duplicating them.

export type HeroMetricRow = {
  key: "cagr" | "vol" | "sharpe" | "maxdd";
  label: string;
  suffix: string;
  signed: boolean;
  negative: boolean;
};

export function heroMetricRows(riskFreeRate: number): HeroMetricRow[] {
  return [
    { key: "cagr", label: "CAGR", suffix: "%", signed: true, negative: false },
    { key: "vol", label: "Volatility (ann.)", suffix: "%", signed: false, negative: false },
    { key: "sharpe", label: `Sharpe (rf=${riskFreeRate}%)`, suffix: "", signed: true, negative: false },
    { key: "maxdd", label: "Max drawdown", suffix: "%", signed: false, negative: true },
  ];
}

export type CompareMetricRow = {
  key: "totalReturn" | "annReturn" | "annVol" | "maxDrawdown" | "rvr";
  label: string;
  suffix: string;
  signed: boolean;
  negative: boolean;
  derived: boolean;
};

export const COMPARE_METRIC_ROWS: readonly CompareMetricRow[] = [
  { key: "totalReturn", label: "Total return", suffix: "%", signed: true, negative: false, derived: false },
  { key: "annReturn", label: "Annualized return", suffix: "%", signed: true, negative: false, derived: false },
  { key: "annVol", label: "Volatility (ann.)", suffix: "%", signed: false, negative: false, derived: false },
  { key: "maxDrawdown", label: "Max drawdown", suffix: "%", signed: false, negative: true, derived: false },
  { key: "rvr", label: "Return / Vol", suffix: "", signed: true, negative: false, derived: true },
];

/** Y-axis label text for the desktop layout. */
export function yAxisLabel(compareMode: "raw" | "pct", currency: string): string {
  return compareMode === "pct" ? "Return vs start (%)" : `Portfolio value (${currency})`;
}

/** Header text above the compare grid ("Performance vs …"). */
export function compareGridHeader(benchmark: string): string {
  return `Performance vs ${benchmark === "none" ? "benchmark" : benchmark}`;
}

/** "% vs start" / "value" chip in the tooltip header. */
export function tooltipModeChip(isPct: boolean): string {
  return isPct ? "% vs start" : "value";
}
