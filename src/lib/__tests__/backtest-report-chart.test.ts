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
    const pct = toReturnPct(curve(100, 110, 99));
    expect(pct[0]).toBeCloseTo(0, 9);
    expect(pct[1]).toBeCloseTo(10, 9);
    expect(pct[2]).toBeCloseTo(-1, 9);
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
    // Exactly one inline script: the hover/tooltip driver.
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain("chart-tip");
    expect(html).not.toContain("undefined");
  });

  it("embeds hover geometry with equity and drawdown for every bar", () => {
    const svg = renderEquityChart([series("ai · swing", [100, 110, 99])], "Equity");
    const match = svg.match(/data-hover="([^"]+)"/);
    expect(match).toBeTruthy();
    const payload = JSON.parse(
      (match as RegExpMatchArray)[1]!
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
    );
    expect(payload.xs).toHaveLength(3);
    expect(payload.labels[1]).toBe("bar 1 · 2026-01-02");
    expect(payload.series[0].equity.map(Math.round)).toEqual([0, 10, -1]);
    expect(payload.series[0].drawdown[2]).toBeCloseTo(-10, 1);
    expect(payload.series[0].px.every((v: number | null) => Number.isFinite(v))).toBe(true);
    expect(svg).toContain('class="hit"');
    expect(svg).toContain('class="dot"');
  });

  it("keeps the drawdown chart hoverable with its own marker positions", () => {
    const svg = renderDrawdownChart([series("ai · swing", [100, 90])], "Drawdown");
    expect(svg).toContain("data-hover=");
    expect((svg.match(/class="dot"/g) ?? []).length).toBe(1);
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
