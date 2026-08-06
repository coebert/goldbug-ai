import { describe, expect, it } from "vitest";
import {
  buildHorizonComparisonPanel,
  buildHorizonComparisonPanels,
  horizonColour,
} from "@/lib/backtest-horizon-panel";
import { renderDrawdownChart, renderEquityChart } from "@/lib/backtest-report-chart";
import type { StyleRunMetrics } from "@/lib/trading-style-backtest";
import type { RiskLevel } from "@/lib/risk-sim-matrix";
import type { TradingStyle } from "@/lib/trading-style";

const curve = (bars: number, drift: number) =>
  Array.from({ length: bars }, (_, i) => ({
    snapshot_date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    total_value: 10_000 * (1 + drift * i),
  }));

const cell = (
  horizon: string,
  style: TradingStyle,
  riskLevel: RiskLevel,
  bars: number,
): StyleRunMetrics =>
  ({
    style,
    riskLevel,
    horizon,
    bars,
    seed: 1,
    totalReturnPct: 5,
    cagrPct: 9,
    maxDrawdownPct: -4,
    sharpe: 1.1,
    tradesPerYear: 12,
    feeDragPct: 0.4,
    equityCurve: curve(bars, style === "swing" ? 0.001 : 0.0005),
    tradeLog: [{ date: "2026-01-02", side: "buy", symbol: "AAPL", quantity: 3, price: 100 }],
  }) as unknown as StyleRunMetrics;

const matrix: StyleRunMetrics[] = [
  cell("3M", "position", "balanced", 6),
  cell("3M", "swing", "balanced", 6),
  cell("1Y", "position", "balanced", 12),
  cell("1Y", "swing", "balanced", 12),
  cell("1Y", "swing", "high", 12),
];

describe("buildHorizonComparisonPanel", () => {
  it("plots every horizon and style for the selected risk level only", () => {
    const p = buildHorizonComparisonPanel("balanced", matrix);
    expect(p.series.map((s) => s.label)).toEqual([
      "3M · position",
      "3M · swing",
      "1Y · position",
      "1Y · swing",
    ]);
    expect(p.heading).toContain("balanced");
  });

  it("shares a colour per horizon and dashes the position style", () => {
    const p = buildHorizonComparisonPanel("balanced", matrix);
    const [pos3m, swing3m, pos1y] = p.series;
    expect(pos3m!.colour).toBe(swing3m!.colour);
    expect(pos3m!.colour).not.toBe(pos1y!.colour);
    expect(pos3m!.dashed).toBe(true);
    expect(swing3m!.dashed).toBeUndefined();
  });

  it("respects an explicit horizon order and drops unknown labels", () => {
    const p = buildHorizonComparisonPanel("balanced", matrix, {
      horizonOrder: ["1Y", "5Y", "3M"],
    });
    expect(p.series.map((s) => s.label)).toEqual([
      "1Y · position",
      "1Y · swing",
      "3M · position",
      "3M · swing",
    ]);
  });

  it("carries the trade log through for marker overlays", () => {
    const p = buildHorizonComparisonPanel("balanced", matrix);
    expect(p.series[0]!.trades).toHaveLength(1);
  });

  it("emits a metric row per plotted series and can be turned off", () => {
    expect(buildHorizonComparisonPanel("balanced", matrix).table!.rows).toHaveLength(4);
    expect(buildHorizonComparisonPanel("balanced", matrix, { table: false }).table).toBeUndefined();
  });

  it("renders shared equity and drawdown axes spanning the longest horizon", () => {
    const p = buildHorizonComparisonPanel("balanced", matrix);
    for (const svg of [
      renderEquityChart(p.series, "Equity"),
      renderDrawdownChart(p.series, "Drawdown"),
    ]) {
      expect(svg).not.toContain("no data");
      expect(svg).not.toContain("NaN");
      // Longest curve (12 bars) sets the x-axis extent.
      expect(svg).toContain("bar 11");
      const payload = JSON.parse(
        (svg.match(/data-hover="([^"]+)"/) as RegExpMatchArray)[1]!.replace(/&quot;/g, '"'),
      );
      expect(payload.series).toHaveLength(4);
      expect(payload.xs).toHaveLength(12);
      // The 6-bar horizon stops early instead of being stretched.
      expect(payload.series[0].px.slice(6).every((v: number | null) => v === null)).toBe(true);
      expect(payload.series[3].px[11]).not.toBeNull();
    }
  });

  it("returns an empty panel when the risk level has no cells", () => {
    const p = buildHorizonComparisonPanel("low", matrix);
    expect(p.series).toEqual([]);
    expect(renderEquityChart(p.series, "Equity")).toContain("no data");
  });

  it("builds one panel per risk level", () => {
    const panels = buildHorizonComparisonPanels(["balanced", "high"], matrix);
    expect(panels).toHaveLength(2);
    expect(panels[1]!.series.map((s) => s.label)).toEqual(["1Y · swing"]);
  });

  it("gives unknown horizons a distinct fallback colour", () => {
    expect(horizonColour("3M")).toBe(horizonColour("3M", 3));
    expect(horizonColour("7Y", 0)).not.toBe(horizonColour("9Y", 1));
  });
});
