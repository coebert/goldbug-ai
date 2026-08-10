// Contract guard for the breakout overlay chart: the reviewer's whole reason
// for opening it is to SEE the range, the broken level and the expected-hold
// exit. Recharts renders nothing measurable under SSR (ResponsiveContainer is
// 0x0), so we stub it and assert on the props each overlay element receives.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildBreakoutOverlay, windowOverlay } from "@/lib/breakout-overlay";
import type { BacktestBar } from "@/lib/breakout-backtest";

type Props = Record<string, unknown>;
const calls: Record<string, Props[]> = {};
const record = (name: string) => {
  const C = (props: Props) => {
    (calls[name] ??= []).push(props);
    return <div data-recharts={name}>{props.children as React.ReactNode}</div>;
  };
  C.displayName = name;
  return C;
};

vi.mock("recharts", () => ({
  ResponsiveContainer: record("ResponsiveContainer"),
  ComposedChart: record("ComposedChart"),
  CartesianGrid: record("CartesianGrid"),
  XAxis: record("XAxis"),
  YAxis: record("YAxis"),
  Tooltip: record("Tooltip"),
  ReferenceLine: record("ReferenceLine"),
  ReferenceArea: record("ReferenceArea"),
  ReferenceDot: record("ReferenceDot"),
  Area: record("Area"),
  Line: record("Line"),
}));

const { BreakoutOverlayChart } = await import("@/components/charts/breakout-overlay-chart");
const { SAXO_COLOR, SAXO_GRID } = await import("@/lib/saxo-chart");

function day(i: number): string {
  const d = new Date(Date.UTC(2024, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}

function series(): BacktestBar[] {
  const bars: BacktestBar[] = [];
  for (let i = 0; i < 130; i++) {
    const c = 100 + (i % 5) * 0.4;
    bars.push({ date: day(i), high: c + 0.5, low: c - 0.5, close: c, volume: 1_000_000 });
  }
  for (let i = 0; i < 20; i++) {
    const c = 104 + i * 1.5;
    bars.push({ date: day(130 + i), high: c + 1, low: c - 0.6, close: c, volume: 3_000_000 });
  }
  return bars;
}

const overlay = windowOverlay(buildBreakoutOverlay("TEST", series()), 120);
const signal = overlay.signals.at(-1)!;
const fmt = (n: number) => n.toFixed(2);

function render(sig = signal) {
  for (const k of Object.keys(calls)) delete calls[k];
  renderToStaticMarkup(
    <BreakoutOverlayChart overlay={overlay} signal={sig} formatPrice={fmt} />,
  );
}

beforeEach(() => render());

describe("BreakoutOverlayChart", () => {
  it("has a signal to draw in the fixture", () => {
    expect(signal).toBeDefined();
    expect(signal.direction).toBe("up");
  });

  it("plots the overlay points as chart data", () => {
    expect(calls["ComposedChart"]![0]!["data"]).toBe(overlay.points);
  });

  it("draws the Donchian range as a stacked band, not a bare line", () => {
    const areas = calls["Area"]!;
    const keys = areas.map((a) => a["dataKey"]);
    expect(keys).toContain("bandBase");
    expect(keys).toContain("bandSpan");
    for (const a of areas) expect(a["stackId"]).toBe("band");
    // Only the span is visible; the base is the invisible pedestal.
    expect(areas.find((a) => a["dataKey"] === "bandBase")!["fill"]).toBe("none");
    expect(areas.find((a) => a["dataKey"] === "bandSpan")!["fill"]).toMatch(/breakout-band/);
  });

  it("draws the close line", () => {
    expect(calls["Line"]!.some((l) => l["dataKey"] === "close")).toBe(true);
  });

  it("rules the broken level at the detector's level, tinted by direction", () => {
    const level = calls["ReferenceLine"]!.find((l) => l["y"] === signal.level);
    expect(level).toBeDefined();
    expect(level!["stroke"]).toBe(SAXO_COLOR.up);
    expect(String((level!["label"] as { value: string }).value)).toContain("Breakout");
  });

  it("rules the ATR stop and target at the signal's own prices", () => {
    const ys = calls["ReferenceLine"]!.map((l) => l["y"]);
    expect(ys).toContain(signal.stop);
    expect(ys).toContain(signal.target);
  });

  it("marks the signal bar and the expected-hold exit as vertical rules", () => {
    const xs = calls["ReferenceLine"]!.filter((l) => l["x"] != null);
    expect(xs.map((l) => l["x"])).toContain(signal.date);
    const labels = xs.map((l) => String((l["label"] as { value: string }).value));
    expect(labels).toContain("Signal");
    expect(labels.some((v) => /exit/i.test(v))).toBe(true);
  });

  it("shades the intended holding window between signal and planned exit", () => {
    const area = calls["ReferenceArea"]![0]!;
    expect(area["x1"]).toBe(signal.date);
    expect(area["x2"]).toBe(signal.plannedExitDate ?? overlay.points.at(-1)!.date);
  });

  it("dots the entry at the signal close", () => {
    const dot = calls["ReferenceDot"]!.find((d) => d["x"] === signal.date);
    expect(dot).toBeDefined();
    expect(dot!["y"]).toBe(signal.entry);
  });

  it("pins an open signal's exit marker to the last bar instead of dropping it", () => {
    const open = { ...signal, plannedExitDate: null, plannedExitIndex: overlay.points.length + 5 };
    render(open);
    const xs = calls["ReferenceLine"]!.filter((l) => l["x"] != null).map((l) => l["x"]);
    expect(xs).toContain(overlay.points.at(-1)!.date);
  });

  it("renders the band and axes but no signal geometry when nothing fired", () => {
    render(null as never);
    expect(calls["Area"]!.length).toBe(2);
    expect(calls["ReferenceLine"] ?? []).toHaveLength(0);
    expect(calls["ReferenceDot"] ?? []).toHaveLength(0);
  });

  it("styles grid and axes from the shared Saxo tokens", () => {
    const grid = calls["CartesianGrid"]![0]!;
    expect(grid["stroke"]).toBe(SAXO_GRID.stroke);
    expect(grid["vertical"]).toBe(false);
    expect(calls["YAxis"]![0]!["axisLine"]).toBe(false);
  });

  it("labels the y-axis with the caller's price formatter", () => {
    const fn = calls["YAxis"]![0]!["tickFormatter"] as (v: number) => string;
    expect(fn(123.456)).toBe("123.46");
  });
});
