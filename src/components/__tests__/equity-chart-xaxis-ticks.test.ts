import { describe, it, expect } from "vitest";
import { xAxisTicks } from "@/components/equity-pct-chart";

/**
 * X-axis labels must never overlap. Recharts drops candidate ticks only when
 * they are closer than `minTickGap`, so the gap has to exceed the widest label
 * the chosen format can produce — and the format itself has to shrink as the
 * span grows.
 */
describe("x-axis tick formatting", () => {
  it("uses time-only labels within a single day", () => {
    const t = xAxisTicks("hourly", 0.9, 24);
    expect(t.style).toBe("time");
    expect(t.format("2026-07-15T13:00:00Z")).toBe("14:00");
  });

  it("uses date+time labels for a week of hourly points", () => {
    const t = xAxisTicks("hourly", 6, 144);
    expect(t.style).toBe("hour");
    expect(t.format("2026-07-15T13:00:00Z")).toContain("Jul");
    expect(t.format("2026-07-15T13:00:00Z")).toContain("14:00");
  });

  it("falls back to date-only labels once hourly data outgrows a week", () => {
    const t = xAxisTicks("hourly", 45, 1000);
    expect(t.style).toBe("day");
    expect(t.format("2026-07-15T13:00:00Z")).toBe("15 Jul");
  });

  it("falls back to month labels on multi-month spans, in both resolutions", () => {
    expect(xAxisTicks("hourly", 400, 8000).style).toBe("month");
    expect(xAxisTicks("daily", 400, 400).style).toBe("month");
    expect(xAxisTicks("daily", 400, 400).format("2026-07-15T13:00:00Z")).toBe("Jul 26");
  });

  it("always leaves more room than the widest label it renders", () => {
    const widest: Record<string, string> = {
      time: "22:00",
      hour: "22 Sept, 22:00",
      day: "22 Sept",
      month: "Sept 26",
    };
    for (const [resolution, span, count] of [
      ["hourly", 0.5, 12],
      ["hourly", 5, 120],
      ["hourly", 60, 1440],
      ["hourly", 900, 20000],
      ["daily", 30, 30],
      ["daily", 900, 900],
    ] as const) {
      const t = xAxisTicks(resolution, span, count);
      // ~7px per character at the 11px axis type used by the chart.
      const estimated = widest[t.style].length * 7;
      expect(t.minTickGap).toBeGreaterThan(estimated);
    }
  });

  it("widens spacing as the series gets denser", () => {
    const sparse = xAxisTicks("hourly", 60, 100);
    const dense = xAxisTicks("hourly", 60, 5000);
    expect(dense.minTickGap).toBeGreaterThan(sparse.minTickGap);
    // Bounded, so a decade of hourly points still shows several ticks.
    expect(dense.minTickGap).toBeLessThanOrEqual(120);
  });

  it("keeps gaps monotonic in density (never shrinks as points are added)", () => {
    let prev = 0;
    for (const n of [10, 100, 500, 2000, 10000]) {
      const gap = xAxisTicks("hourly", 200, n).minTickGap;
      expect(gap).toBeGreaterThanOrEqual(prev);
      prev = gap;
    }
  });
});
