// Regression guard: the fear-index chart must style its grid, axes, reference
// rules and tooltip from the shared chart tokens in `@/lib/chart-palette`, not
// from Recharts' white-page defaults or inline literals.
//
// Recharts is stubbed with prop-recording components so we can assert on the
// exact props the card passes (SSR of <ResponsiveContainer> measures 0×0 and
// renders no chart internals, so markup alone can't prove this).

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART_SERIES_COLORS,
  GRID_PROPS,
  REFERENCE_LINE,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
} from "@/lib/chart-palette";

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
  LineChart: record("LineChart"),
  CartesianGrid: record("CartesianGrid"),
  XAxis: record("XAxis"),
  YAxis: record("YAxis"),
  Tooltip: record("Tooltip"),
  ReferenceLine: record("ReferenceLine"),
  Line: record("Line"),
}));

vi.mock("@tanstack/react-start", () => ({ useServerFn: () => async () => ({}) }));
vi.mock("@/lib/fear-index.functions", () => ({ getFearIndexSnapshot: { __fn: "snapshot" } }));

const SNAPSHOT = {
  score: 72,
  labelText: "Fear",
  runDate: "2026-07-30",
  sizeMultiplier: 0.7,
  reason: "Elevated volatility.",
  blockedBuys: [] as string[],
  impacts: [] as unknown[],
  history: [
    { run_date: "2026-07-28", score: 55 },
    { run_date: "2026-07-29", score: 64 },
    { run_date: "2026-07-30", score: 72 },
  ],
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: SNAPSHOT, isLoading: false, isError: false }),
}));

const { FearIndexCard } = await import("@/components/fear-index-card");

function renderCard() {
  for (const k of Object.keys(calls)) delete calls[k];
  const html = renderToStaticMarkup(<FearIndexCard portfolioId="p1" />);
  return html;
}

describe("fear-index chart uses shared chart tokens", () => {
  beforeEach(() => {
    renderCard();
  });

  it("renders the trend chart when history has more than one point", () => {
    expect(calls.LineChart).toHaveLength(1);
    expect(calls.LineChart[0].data).toEqual(SNAPSHOT.history);
  });

  it("styles the grid with GRID_PROPS", () => {
    expect(calls.CartesianGrid).toHaveLength(1);
    const grid = calls.CartesianGrid[0];
    expect(grid.stroke).toBe(GRID_PROPS.stroke);
    expect(grid.strokeDasharray).toBe(GRID_PROPS.strokeDasharray);
  });

  it("styles every reference rule with REFERENCE_LINE", () => {
    // Fear (60) and panic (80) thresholds.
    expect(calls.ReferenceLine).toHaveLength(2);
    expect(calls.ReferenceLine.map((r) => r.y)).toEqual([60, 80]);
    for (const rl of calls.ReferenceLine) {
      expect(rl.stroke).toBe(REFERENCE_LINE.stroke);
      expect(rl.strokeDasharray).toBe(REFERENCE_LINE.strokeDasharray);
    }
  });

  it("styles both axes with the shared tick / axis-line tokens", () => {
    for (const axis of [...calls.XAxis, ...calls.YAxis]) {
      expect(axis.tick).toEqual(AXIS_TICK);
      expect(axis.tickLine).toEqual(TICK_LINE);
      expect(axis.axisLine).toEqual(AXIS_LINE);
    }
    expect(calls.XAxis).toHaveLength(1);
    expect(calls.YAxis).toHaveLength(1);
  });

  it("styles the tooltip surface with TOOLTIP_CONTENT_STYLE", () => {
    expect(calls.Tooltip[0].contentStyle).toEqual(TOOLTIP_CONTENT_STYLE);
  });

  it("draws the series with an approved palette colour, never a raw literal", () => {
    expect(calls.Line).toHaveLength(1);
    expect(CHART_SERIES_COLORS).toContain(calls.Line[0].stroke as string);
  });

  it("passes no hardcoded colour literals to any chart primitive", () => {
    const literal = /^(#|rgb|hsl)/i;
    for (const [name, propsList] of Object.entries(calls)) {
      for (const props of propsList) {
        for (const [key, value] of Object.entries(props)) {
          if (typeof value !== "string" || !literal.test(value)) continue;
          expect(
            CHART_SERIES_COLORS.includes(value),
            `${name}.${key} uses unapproved colour ${value}`,
          ).toBe(true);
        }
      }
    }
  });
});
