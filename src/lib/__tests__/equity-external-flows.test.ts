import { describe, it, expect } from "vitest";
import {
  detectExternalFlows,
  mergeFlows,
  flowAdjustedStats,
  type EquityPoint,
} from "../equity-external-flows";

const p = (date: string, cash: number, holdingsValue: number): EquityPoint => ({
  date,
  cash,
  holdingsValue,
  totalValue: cash + holdingsValue,
});

describe("detectExternalFlows", () => {
  it("flags a large pure-cash deposit", () => {
    const flows = detectExternalFlows([
      p("2026-07-23", 813871.36, 0),
      p("2026-07-24", 1812871.36, 0),
    ]);
    expect(flows).toEqual([
      { date: "2026-07-24", amount: 999000, source: "detected" },
    ]);
  });

  it("flags a large pure-cash withdrawal as negative", () => {
    const flows = detectExternalFlows([
      p("2026-08-05", 1628022.8, 182595.81),
      p("2026-08-06", 789348.03, 182363.51),
    ]);
    expect(flows).toHaveLength(1);
    expect(flows[0].amount).toBeCloseTo(-838674.77, 2);
  });

  it("never flags a buy: cash and holdings move together", () => {
    // Half the book rotated from cash into holdings — a huge cash move, but
    // holdings absorb it exactly.
    expect(detectExternalFlows([
      p("2026-08-01", 100000, 0),
      p("2026-08-02", 40000, 60000),
    ])).toEqual([]);
  });

  it("never flags a sell", () => {
    expect(detectExternalFlows([
      p("2026-08-01", 10000, 90000),
      p("2026-08-02", 95000, 5000),
    ])).toEqual([]);
  });

  it("ignores small cash moves below the absolute floor", () => {
    expect(detectExternalFlows([
      p("2026-08-01", 1000, 0),
      p("2026-08-02", 1400, 0),
    ])).toEqual([]);
  });

  it("ignores moves below the relative share even when large in absolute terms", () => {
    expect(detectExternalFlows([
      p("2026-08-01", 10_000_000, 0),
      p("2026-08-02", 10_600_000, 0),
    ])).toEqual([]);
  });

  it("is order-insensitive", () => {
    const rows = [
      p("2026-07-24", 1812871.36, 0),
      p("2026-07-23", 813871.36, 0),
    ];
    expect(detectExternalFlows(rows)).toEqual(detectExternalFlows([...rows].reverse()));
  });
});

describe("mergeFlows", () => {
  it("prefers the recorded amount over a detected one on the same date", () => {
    const merged = mergeFlows(
      [{ date: "2026-07-24", amount: 999000, source: "recorded" }],
      [{ date: "2026-07-24", amount: 998999, source: "detected" }],
    );
    expect(merged).toEqual([{ date: "2026-07-24", amount: 999000, source: "recorded" }]);
  });

  it("keeps detected flows that have no recorded counterpart", () => {
    const merged = mergeFlows(
      [{ date: "2026-07-24", amount: 999000, source: "recorded" }],
      [{ date: "2026-08-06", amount: -838674.77, source: "detected" }],
    );
    expect(merged.map((f) => f.date)).toEqual(["2026-07-24", "2026-08-06"]);
  });
});

describe("flowAdjustedStats", () => {
  // The real regression: a 999k deposit then an 838k outflow made the balanced
  // sim look 44% underwater and halted every BUY.
  const series: EquityPoint[] = [
    p("2026-07-23", 813871.36, 0),
    p("2026-07-24", 1812871.36, 0),
    p("2026-07-29", 1412373.08, 404137.97),
    p("2026-08-05", 1628022.8, 182595.81),
    p("2026-08-06", 789348.03, 182363.51),
    p("2026-08-10", 844409.38, 183903.5),
  ];

  it("removes the deposit/withdrawal artefact from the peak", () => {
    const flows = mergeFlows([], detectExternalFlows(series));
    const stats = flowAdjustedStats(series, flows, "2026-08-10");
    const current = 844409.38 + 183903.5;
    // Raw peak is 1.82m — a 43% "drawdown" against today's 1.03m.
    const rawPeak = Math.max(...series.map((s) => s.totalValue));
    expect((rawPeak - current) / rawPeak).toBeGreaterThan(0.4);
    // Flow-adjusted, the book never traded above roughly current equity.
    expect(stats.peakEquity!).toBeLessThan(current * 1.01);
    const adjDrawdown = Math.max(0, (stats.peakEquity! - current) / stats.peakEquity!);
    expect(adjDrawdown).toBeLessThan(0.05);
  });

  it("still reports a genuine trading drawdown", () => {
    const losing: EquityPoint[] = [
      p("2026-08-01", 50000, 50000),
      p("2026-08-02", 50000, 40000),
      p("2026-08-03", 50000, 20000),
    ];
    const stats = flowAdjustedStats(losing, [], "2026-08-03");
    expect(stats.peakEquity).toBe(100000);
    const dd = (stats.peakEquity! - 70000) / stats.peakEquity!;
    expect(dd).toBeCloseTo(0.3, 6);
  });

  it("returns the last snapshot strictly before asOf as prior close", () => {
    const stats = flowAdjustedStats(series, [], "2026-08-10");
    expect(stats.priorCloseEquity).toBeCloseTo(789348.03 + 182363.51, 2);
  });

  it("handles an empty series", () => {
    expect(flowAdjustedStats([], [], "2026-08-10")).toEqual({
      peakEquity: null,
      priorCloseEquity: null,
      netFlow: 0,
    });
  });

  it("nets recorded flows even when detection would miss them", () => {
    const pts = [p("2026-08-01", 1000, 0), p("2026-08-02", 1000, 0)];
    const stats = flowAdjustedStats(
      pts,
      [{ date: "2026-08-02", amount: 400, source: "recorded" }],
      "2026-08-02",
    );
    expect(stats.netFlow).toBe(400);
  });
});
