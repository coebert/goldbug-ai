import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXIT_SWEEP_GRID,
  DEFAULT_EXIT_SWEEP_OBJECTIVE,
  LIVE_EXIT_PARAMS,
  exitHeatmap,
  exitParamKey,
  expandExitGrid,
  formatExitSweepReport,
  runBreakoutExitSweep,
  scoreExit,
  type ExitCohortEdge,
} from "@/lib/breakout-exit-sweep";
import type { SymbolBars, BacktestBar } from "@/lib/breakout-backtest";

function series(symbol: string, n = 600, seed = 1): SymbolBars {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5);
  const bars: BacktestBar[] = [];
  let px = 100;
  const start = Date.UTC(2022, 0, 3);
  for (let i = 0; i < n; i++) {
    // Base-then-break shape so the detector actually fires.
    const drift = Math.floor(i / 60) % 2 === 0 ? 0.0 : 0.006;
    px = Math.max(5, px * (1 + drift + rnd() * 0.02));
    const high = px * (1 + Math.abs(rnd()) * 0.01);
    const low = px * (1 - Math.abs(rnd()) * 0.01);
    const d = new Date(start + i * 86400000).toISOString().slice(0, 10);
    bars.push({ date: d, high, low, close: px, volume: 1_000_000 * (1 + Math.abs(rnd())) });
  }
  return { symbol, bars };
}

const edge = (over: Partial<ExitCohortEdge> = {}): ExitCohortEdge => ({
  trades: 50,
  winRatePct: 50,
  avgReturnPct: 0,
  expectancyPct: 0,
  maxDrawdownPct: -20,
  profitFactor: 1,
  avgBarsHeld: 8,
  ...over,
});

describe("expandExitGrid", () => {
  it("produces the cartesian product of stop x target x horizon", () => {
    const combos = expandExitGrid({ stopAtr: [1, 2], targetAtr: [2, 3, 4], horizonBars: [10] });
    expect(combos).toHaveLength(6);
  });

  it("dedupes identical combinations", () => {
    const combos = expandExitGrid({ stopAtr: [2, 2], targetAtr: [3], horizonBars: [10] });
    expect(combos).toHaveLength(1);
  });

  it("puts the live baseline first so it is always evaluated", () => {
    const combos = expandExitGrid(DEFAULT_EXIT_SWEEP_GRID);
    expect(exitParamKey(combos[0]!)).toBe(exitParamKey(LIVE_EXIT_PARAMS));
  });

  it("covers the requested 1-3 ATR stop and 2-5 ATR target range by default", () => {
    expect(Math.min(...DEFAULT_EXIT_SWEEP_GRID.stopAtr)).toBe(1);
    expect(Math.max(...DEFAULT_EXIT_SWEEP_GRID.stopAtr)).toBe(3);
    expect(Math.min(...DEFAULT_EXIT_SWEEP_GRID.targetAtr)).toBe(2);
    expect(Math.max(...DEFAULT_EXIT_SWEEP_GRID.targetAtr)).toBe(5);
  });

  it("rejects an empty axis", () => {
    expect(() => expandExitGrid({ stopAtr: [], targetAtr: [2], horizonBars: [10] })).toThrow();
  });
});

describe("scoreExit", () => {
  const obj = DEFAULT_EXIT_SWEEP_OBJECTIVE;

  it("rewards a higher win rate", () => {
    expect(scoreExit({ confirmed: edge({ winRatePct: 60 }) }, obj)).toBeGreaterThan(
      scoreExit({ confirmed: edge({ winRatePct: 45 }) }, obj),
    );
  });

  it("penalises a deeper drawdown", () => {
    expect(scoreExit({ confirmed: edge({ maxDrawdownPct: -10 }) }, obj)).toBeGreaterThan(
      scoreExit({ confirmed: edge({ maxDrawdownPct: -60 }) }, obj),
    );
  });

  it("does not let a high win rate outrank a badly negative expectancy", () => {
    const flatterer = scoreExit(
      { confirmed: edge({ winRatePct: 70, expectancyPct: -1.5 }) },
      obj,
    );
    const honest = scoreExit({ confirmed: edge({ winRatePct: 48, expectancyPct: 0.6 }) }, obj);
    expect(honest).toBeGreaterThan(flatterer);
  });
});

describe("runBreakoutExitSweep", () => {
  const tape = [series("AAA", 600, 7), series("BBB", 600, 99)];

  const report = runBreakoutExitSweep(tape, {
    grid: { stopAtr: [1, 2, 3], targetAtr: [2, 3, 5], horizonBars: [10] },
    objective: { minConfirmedTrades: 1 },
  });

  it("evaluates the whole grid", () => {
    expect(report.gridSize).toBe(9);
    expect(report.results.length + report.results.filter((r) => r.disqualified).length).toBeLessThanOrEqual(9);
  });

  it("always includes the live baseline row", () => {
    expect(exitParamKey(report.baseline.params)).toBe(exitParamKey(LIVE_EXIT_PARAMS));
  });

  it("ranks results best-first by the blended score", () => {
    const scores = report.results.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("computes reward:risk from the stop/target pair", () => {
    for (const r of report.results) {
      expect(r.rewardRisk).toBeCloseTo(r.params.targetAtr / r.params.stopAtr, 8);
    }
  });

  it("surfaces the per-axis winners", () => {
    if (!report.results.length) return;
    const maxWin = Math.max(...report.results.map((r) => r.confirmed.winRatePct));
    const maxDd = Math.max(...report.results.map((r) => r.confirmed.maxDrawdownPct));
    expect(report.bestWinRate!.confirmed.winRatePct).toBeCloseTo(maxWin, 8);
    expect(report.bestDrawdown!.confirmed.maxDrawdownPct).toBeCloseTo(maxDd, 8);
  });

  it("reports the date range covered", () => {
    expect(report.symbols).toEqual(["AAA", "BBB"]);
    expect(report.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("keeps confirmed-cohort regime breakdowns", () => {
    for (const r of report.results) {
      expect(Object.keys(r.byRegime).sort()).toEqual(["bear", "bull", "sideways"]);
    }
  });

  it("disqualifies combos below the minimum confirmed sample and excludes them from ranking", () => {
    const strict = runBreakoutExitSweep(tape, {
      grid: { stopAtr: [2], targetAtr: [3], horizonBars: [10] },
      objective: { minConfirmedTrades: 100_000 },
    });
    expect(strict.results).toHaveLength(0);
    expect(strict.bestWinRate).toBeNull();
    expect(strict.baseline.disqualified).toContain("confirmed signals");
    expect(strict.baseline.score).toBe(-Infinity);
  });

  it("a wider stop holds trades longer than a tight one", () => {
    const tight = report.results.concat(report.baseline).find((r) => r.params.stopAtr === 1);
    const wide = report.results.concat(report.baseline).find((r) => r.params.stopAtr === 3);
    if (tight && wide && tight.confirmed.trades > 3 && wide.confirmed.trades > 3) {
      expect(wide.confirmed.avgBarsHeld).toBeGreaterThanOrEqual(tight.confirmed.avgBarsHeld);
    }
  });

  it("reports progress for every combination", () => {
    const seen: number[] = [];
    runBreakoutExitSweep(tape, {
      grid: { stopAtr: [1, 2], targetAtr: [3], horizonBars: [10] },
      objective: { minConfirmedTrades: 1 },
      onProgress: (done, total) => {
        seen.push(done);
        expect(total).toBe(2);
      },
    });
    expect(seen).toEqual([1, 2]);
  });

  it("produces a heatmap grid aligned to the swept axes", () => {
    const hm = exitHeatmap(report, "winRatePct");
    expect(hm.stops).toEqual([1, 2, 3]);
    expect(hm.targets).toEqual([2, 3, 5]);
    expect(hm.cells).toHaveLength(3);
    expect(hm.cells[0]).toHaveLength(3);
  });

  it("formats a readable text report", () => {
    const text = formatExitSweepReport(report);
    expect(text).toContain("BREAKOUT EXIT SWEEP");
    expect(text).toContain("live");
  });
});
