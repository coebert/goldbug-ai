/**
 * Combined horizon comparison panel.
 *
 * The per-risk-level report panels plot one horizon at a time, which makes it
 * hard to see whether an edge is horizon-specific or holds across 3M → 2Y.
 * This builder overlays EVERY horizon (for both styles) on the same equity and
 * drawdown axes for a single selected risk level. Curves are shorter or longer
 * depending on the horizon; `renderLineChart` already spans the longest series
 * and leaves the rest ending early, which is exactly the read we want.
 */
import type { ChartSeries, ReportPanel } from "@/lib/backtest-report-chart";
import type { StyleRunMetrics } from "@/lib/trading-style-backtest";
import type { RiskLevel } from "@/lib/risk-sim-matrix";
import type { TradingStyle } from "@/lib/trading-style";

/** Distinct hue per horizon; shade is constant so the style dash carries style. */
export const HORIZON_COLOURS: Record<string, string> = {
  "3M": "#f5a623",
  "6M": "#33d69f",
  "1Y": "#4da3ff",
  "2Y": "#a78bfa",
};
const FALLBACK_COLOURS = ["#e5484d", "#9aa4b2", "#f472b6", "#22d3ee"];

/** Stable colour for a horizon label, falling back for custom horizons. */
export function horizonColour(label: string, index = 0): string {
  return HORIZON_COLOURS[label] ?? FALLBACK_COLOURS[index % FALLBACK_COLOURS.length]!;
}

export type HorizonPanelOptions = {
  /** Order to plot horizons in; defaults to first-seen order in `metrics`. */
  horizonOrder?: readonly string[];
  /** Styles to include; defaults to both, position dashed. */
  styles?: readonly TradingStyle[];
  subtitle?: string;
  /** Include the per-cell metric table under the charts. Default true. */
  table?: boolean;
};

const TABLE_COLUMNS = [
  "horizon",
  "style",
  "return %",
  "CAGR %",
  "maxDD %",
  "sharpe",
  "trades/y",
  "fees %",
];

const n = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");

/**
 * Build one panel that plots all horizons for `riskLevel` on shared axes.
 * Metrics for other risk levels are ignored, so callers can pass the whole
 * averaged matrix.
 */
export function buildHorizonComparisonPanel(
  riskLevel: RiskLevel,
  metrics: readonly StyleRunMetrics[],
  options: HorizonPanelOptions = {},
): ReportPanel {
  const cells = metrics.filter((m) => m.riskLevel === riskLevel);
  const styles = options.styles ?? (["position", "swing"] as const);

  const seen: string[] = [];
  for (const m of cells) if (!seen.includes(m.horizon)) seen.push(m.horizon);
  const order = options.horizonOrder
    ? options.horizonOrder.filter((h) => seen.includes(h))
    : seen;

  const series: ChartSeries[] = [];
  const rows: string[][] = [];
  order.forEach((horizon, hi) => {
    for (const style of styles) {
      const m = cells.find((c) => c.horizon === horizon && c.style === style);
      if (!m || m.equityCurve.length < 2) continue;
      series.push({
        label: `${horizon} · ${style}`,
        colour: horizonColour(horizon, hi),
        // Dash separates the two styles within a horizon's shared colour.
        ...(style === "position" ? { dashed: true } : {}),
        curve: m.equityCurve,
        trades: m.tradeLog ?? [],
      });
      rows.push([
        horizon,
        style,
        n(m.totalReturnPct),
        n(m.cagrPct),
        n(m.maxDrawdownPct),
        n(m.sharpe),
        n(m.tradesPerYear, 1),
        n(m.feeDragPct),
      ]);
    }
  });

  return {
    heading: `${riskLevel} risk — all horizons combined`,
    subtitle:
      options.subtitle ??
      `${order.length || 0} horizons × ${styles.length} styles on shared axes` +
        ` · solid = swing, dashed = position`,
    series,
    ...(options.table === false ? {} : { table: { columns: TABLE_COLUMNS, rows } }),
  };
}

/** One combined panel per risk level, in the order given. */
export function buildHorizonComparisonPanels(
  riskLevels: readonly RiskLevel[],
  metrics: readonly StyleRunMetrics[],
  options: HorizonPanelOptions = {},
): ReportPanel[] {
  return riskLevels.map((r) => buildHorizonComparisonPanel(r, metrics, options));
}
