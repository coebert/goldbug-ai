import { describe, expect, it } from "vitest";
import {
  renderBacktestReportHtml,
  renderDrawdownChart,
  renderEquityChart,
  toDrawdownPct,
  toReturnPct,
  type ChartSeries,
} from "@/lib/backtest-report-chart";

const curve = (...values: number[]) =>
  values.map((v, i) => ({ snapshot_date: `2026-01-${String(i + 1).padStart(2, "0")}`, total_value: v }));

const series = (label: string, values: number[], dashed = false): ChartSeries => ({
  label,
  colour: "#4da3ff",
  ...(dashed ? { dashed: true } : {}),
  curve: curve(...values),
});

describe("backtest report charts", () => {
  it("expresses the equity curve as % from the first point", () => {
    expect(toReturnPct(curve(100, 110, 99))).toEqual([0, 10, -1]);
  });

  it("measures drawdown against the running high-water mark", () => {
    const dd = toDrawdownPct(curve(100, 120, 90, 96, 150));
    expect(dd[0]).toBe(0);
    expect(dd[1]).toBe(0);
    expect(dd[2]).toBeCloseTo(-25, 6);
    expect(dd[3]).toBeCloseTo(-20, 6);
    expect(dd[4]).toBe(0); // new high resets the drawdown
  });

  it("never reports a positive drawdown", () => {
    for (const v of toDrawdownPct(curve(10, 40, 5, 80, 79, 200))) expect(v).toBeLessThanOrEqual(0);
  });

  it("draws one path per series and dashes the control layer", () => {
    const svg = renderEquityChart(
      [series("ai", [100, 102, 101]), series("heuristic", [100, 99, 103], true)],
      "Equity",
    );
    expect(svg.match(/class="line"/g)).toHaveLength(2);
    expect(svg).toContain('stroke-dasharray="5 4"');
    expect(svg).toContain("Equity");
  });

  it("fills the drawdown area and keeps flat curves off the axis edge", () => {
    const svg = renderDrawdownChart([series("flat", [100, 100, 100])], "Drawdown");
    expect(svg).toContain('class="area"');
    expect(svg).not.toContain("no data");
    expect(svg).not.toContain("NaN");
  });

  it("degrades to a no-data chart instead of emitting broken geometry", () => {
    const svg = renderEquityChart([{ label: "empty", colour: "#fff", curve: [] }], "Equity");
    expect(svg).toContain("no data");
    expect(svg).not.toContain('class="line"');
  });

  it("renders a self-contained HTML report with a panel per risk level", () => {
    const html = renderBacktestReportHtml({
      title: "Swing vs position",
      subtitle: "126 bars",
      panels: [
        {
          heading: "balanced risk",
          series: [series("ai · swing", [100, 101])],
          table: { columns: ["Cell", "Ret%"], rows: [["ai · swing", "1.00"]] },
        },
        { heading: "high risk", series: [series("ai · swing", [100, 98])] },
      ],
    });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.match(/<section class="panel">/g)).toHaveLength(2);
    expect(html).toContain("balanced risk");
    expect(html).toContain("<table>");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("undefined");
  });

  it("escapes labels so a hostile series name cannot inject markup", () => {
    const html = renderBacktestReportHtml({
      title: "<img src=x>",
      panels: [{ heading: "risk", series: [series('a"><script>alert(1)</script>', [1, 2])] }],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
