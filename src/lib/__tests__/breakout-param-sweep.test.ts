import { describe, it, expect } from "vitest";
import {
  DEFAULT_SWEEP_GRID,
  DEFAULT_SWEEP_OBJECTIVE,
  baselineParams,
  expandGrid,
  formatSweepReport,
  paramKey,
  runBreakoutParamSweep,
  scoreEdge,
  seriesDates,
  splitSeries,
  type SliceEdge,
} from "@/lib/breakout-param-sweep";
import { DEFAULT_BREAKOUT_CONFIG } from "@/lib/alpha/breakout";
import type { SymbolBars } from "@/lib/breakout-backtest";

function synthSeries(symbol: string, n: number, seed: number): SymbolBars {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const bars = [];
  let px = 100;
  const start = new Date(Date.UTC(2022, 0, 3));
  for (let i = 0; i < n; i++) {
    // Alternating regimes: quiet base then a thrust, so breakouts actually fire.
    const phase = Math.floor(i / 40) % 2;
    const drift = phase === 0 ? 0 : 0.004;
    px = Math.max(5, px * (1 + drift + (rnd() - 0.5) * (phase === 0 ? 0.004 : 0.02)));
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    bars.push({
      date: d.toISOString().slice(0, 10),
      high: px * (1 + rnd() * 0.01),
      low: px * (1 - rnd() * 0.01),
      close: px,
      volume: 1_000_000 * (0.6 + rnd() * (phase === 0 ? 0.8 : 2.4)),
    });
  }
  return { symbol, bars };
}

const SERIES: SymbolBars[] = [
  synthSeries("AAA", 420, 7),
  synthSeries("BBB", 420, 991),
  synthSeries("CCC", 420, 45231),
];

const SMALL_GRID = {
  channelBars: [20, 55],
  minBaseBars: [10],
  maxBasePct: [0.18],
  minPenetrationAtr: [0, 0.25],
  minVolumeRatio: [1, 1.4],
} as const;

describe("expandGrid", () => {
  it("produces the full cartesian product", () => {
    const combos = expandGrid(DEFAULT_SWEEP_GRID);
    const expected =
      DEFAULT_SWEEP_GRID.channelBars.length *
      DEFAULT_SWEEP_GRID.minBaseBars.length *
      DEFAULT_SWEEP_GRID.maxBasePct.length *
      DEFAULT_SWEEP_GRID.minPenetrationAtr.length *
      DEFAULT_SWEEP_GRID.minVolumeRatio.length;
    expect(combos.length).toBe(expected);
  });

  it("de-duplicates repeated axis values", () => {
    const combos = expandGrid({
      ...DEFAULT_SWEEP_GRID,
      channelBars: [55, 55, 20],
    });
    expect(new Set(combos.map(paramKey)).size).toBe(combos.length);
  });

  it("keeps the shipped defaults first so a cap never drops the baseline", () => {
    const combos = expandGrid(DEFAULT_SWEEP_GRID, 5);
    expect(combos.length).toBe(5);
    expect(paramKey(combos[0]!)).toBe(paramKey(baselineParams()));
  });

  it("throws on an empty axis", () => {
    expect(() => expandGrid({ ...DEFAULT_SWEEP_GRID, minVolumeRatio: [] })).toThrow(/empty/);
  });

  it("baselineParams mirrors the live detector config", () => {
    const b = baselineParams();
    expect(b.channelBars).toBe(DEFAULT_BREAKOUT_CONFIG.channelBars);
    expect(b.minPenetrationAtr).toBe(DEFAULT_BREAKOUT_CONFIG.minPenetrationAtr);
    expect(b.minVolumeRatio).toBe(DEFAULT_BREAKOUT_CONFIG.minVolumeRatio);
  });
});

describe("splitSeries", () => {
  it("cuts every symbol at the same date", () => {
    const { train, holdout, trainRange, holdoutRange } = splitSeries(SERIES, 0.7);
    expect(trainRange && holdoutRange).toBeTruthy();
    for (const s of train) expect(s.bars.every((b) => b.date <= trainRange!.to)).toBe(true);
    for (const s of holdout) expect(s.bars.every((b) => b.date >= holdoutRange!.from)).toBe(true);
    expect(trainRange!.to < holdoutRange!.from).toBe(true);
  });

  it("never leaks a bar into both slices", () => {
    const { train, holdout } = splitSeries(SERIES, 0.6);
    const trainKeys = new Set(train.flatMap((s) => s.bars.map((b) => `${s.symbol}@${b.date}`)));
    for (const s of holdout) {
      for (const b of s.bars) expect(trainKeys.has(`${s.symbol}@${b.date}`)).toBe(false);
    }
  });

  it("preserves the total bar count", () => {
    const total = SERIES.reduce((a, s) => a + s.bars.length, 0);
    const { train, holdout } = splitSeries(SERIES, 0.7);
    const split =
      train.reduce((a, s) => a + s.bars.length, 0) + holdout.reduce((a, s) => a + s.bars.length, 0);
    expect(split).toBe(total);
  });

  it("returns everything as training when the fraction is 1", () => {
    const { train, holdout, holdoutRange } = splitSeries(SERIES, 1);
    expect(holdout).toEqual([]);
    expect(holdoutRange).toBeNull();
    expect(train.reduce((a, s) => a + s.bars.length, 0)).toBe(
      SERIES.reduce((a, s) => a + s.bars.length, 0),
    );
  });

  it("seriesDates is sorted and unique", () => {
    const dates = seriesDates(SERIES);
    expect(dates).toEqual([...new Set(dates)].sort());
  });
});

describe("scoreEdge", () => {
  const base: SliceEdge = {
    signals: 100,
    confirmedTrades: 40,
    failedTrades: 40,
    confirmedWinRatePct: 50,
    confirmedAvgReturnPct: 1,
    confirmedExpectancyPct: 1,
    confirmedMaxDrawdownPct: -10,
    failedAvgReturnPct: 0,
    avgReturnGapPct: 1,
    winRateGapPp: 5,
  };

  it("rewards higher confirmed return", () => {
    expect(scoreEdge({ ...base, confirmedAvgReturnPct: 2 }, DEFAULT_SWEEP_OBJECTIVE)).toBeGreaterThan(
      scoreEdge(base, DEFAULT_SWEEP_OBJECTIVE),
    );
  });

  it("rewards a bigger gap over the failed cohort", () => {
    expect(scoreEdge({ ...base, avgReturnGapPct: 3 }, DEFAULT_SWEEP_OBJECTIVE)).toBeGreaterThan(
      scoreEdge(base, DEFAULT_SWEEP_OBJECTIVE),
    );
  });

  it("penalises deeper drawdown", () => {
    expect(
      scoreEdge({ ...base, confirmedMaxDrawdownPct: -60 }, DEFAULT_SWEEP_OBJECTIVE),
    ).toBeLessThan(scoreEdge(base, DEFAULT_SWEEP_OBJECTIVE));
  });

  it("is deterministic", () => {
    expect(scoreEdge(base, DEFAULT_SWEEP_OBJECTIVE)).toBe(scoreEdge(base, DEFAULT_SWEEP_OBJECTIVE));
  });
});

describe("runBreakoutParamSweep", () => {
  const report = runBreakoutParamSweep(SERIES, {
    grid: SMALL_GRID,
    objective: { minConfirmedTrades: 5, trainFraction: 0.7 },
    backtest: { horizonBars: 10, stopAtr: 2, targetAtr: 3, costBps: 20, warmupBars: 60 },
  });

  it("evaluates every combination in the grid", () => {
    expect(report.gridSize).toBe(8);
    expect(report.evaluated).toBe(8);
  });

  it("always reports the baseline even when it is not in the grid", () => {
    const narrow = runBreakoutParamSweep(SERIES, {
      grid: { ...SMALL_GRID, channelBars: [20], minVolumeRatio: [3.5] },
      objective: { minConfirmedTrades: 5 },
      backtest: { warmupBars: 60 },
    });
    expect(paramKey(narrow.baseline.params)).toBe(paramKey(baselineParams()));
  });

  it("ranks results best-first and excludes disqualified candidates", () => {
    for (let i = 1; i < report.results.length; i++) {
      expect(report.results[i - 1]!.score).toBeGreaterThanOrEqual(report.results[i]!.score);
    }
    expect(report.results.every((r) => r.disqualified === null)).toBe(true);
  });

  it("disqualifies thin candidates instead of ranking them", () => {
    const strict = runBreakoutParamSweep(SERIES, {
      grid: SMALL_GRID,
      objective: { minConfirmedTrades: 100000 },
      backtest: { warmupBars: 60 },
    });
    expect(strict.results).toEqual([]);
    expect(strict.baseline.status).toBe("thin");
    expect(strict.baseline.score).toBe(-Infinity);
    expect(strict.verdict).toBe("no_positive_edge");
  });

  it("only marks a winner accepted when the holdout is also positive", () => {
    if (report.best) {
      expect(report.best.train.confirmedAvgReturnPct).toBeGreaterThan(0);
      expect(report.best.holdout!.confirmedAvgReturnPct).toBeGreaterThan(0);
      expect(report.verdict).toBe("found_positive_edge");
    } else {
      expect(["train_only", "no_positive_edge"]).toContain(report.verdict);
    }
  });

  it("labels train-positive/holdout-negative candidates as overfit", () => {
    for (const r of report.results) {
      if (r.train.confirmedAvgReturnPct > 0 && r.holdout && r.holdout.confirmedAvgReturnPct <= 0) {
        expect(r.status).toBe("overfit");
      }
      if (r.train.confirmedAvgReturnPct <= 0) expect(r.status).toBe("rejected");
    }
  });

  it("holds the backtest settings fixed across candidates", () => {
    const a = runBreakoutParamSweep(SERIES, {
      grid: SMALL_GRID,
      objective: { minConfirmedTrades: 5 },
      backtest: { costBps: 0, warmupBars: 60 },
    });
    const b = runBreakoutParamSweep(SERIES, {
      grid: SMALL_GRID,
      objective: { minConfirmedTrades: 5 },
      backtest: { costBps: 200, warmupBars: 60 },
    });
    // Heavier costs cannot improve the confirmed cohort's average return.
    expect(b.baseline.train.confirmedAvgReturnPct).toBeLessThanOrEqual(
      a.baseline.train.confirmedAvgReturnPct + 1e-9,
    );
  });

  it("is deterministic for identical inputs", () => {
    const again = runBreakoutParamSweep(SERIES, {
      grid: SMALL_GRID,
      objective: { minConfirmedTrades: 5, trainFraction: 0.7 },
      backtest: { horizonBars: 10, stopAtr: 2, targetAtr: 3, costBps: 20, warmupBars: 60 },
    });
    expect(again.results.map((r) => [paramKey(r.params), r.score])).toEqual(
      report.results.map((r) => [paramKey(r.params), r.score]),
    );
  });

  it("reports progress once per candidate", () => {
    const seen: number[] = [];
    runBreakoutParamSweep(SERIES, {
      grid: SMALL_GRID,
      objective: { minConfirmedTrades: 5 },
      backtest: { warmupBars: 60 },
      onProgress: (done, total) => {
        seen.push(done);
        expect(total).toBe(8);
      },
    });
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("honours the candidate cap", () => {
    const capped = runBreakoutParamSweep(SERIES, {
      grid: SMALL_GRID,
      objective: { minConfirmedTrades: 5 },
      backtest: { warmupBars: 60 },
      maxCandidates: 3,
    });
    expect(capped.evaluated).toBe(3);
  });

  it("formats a readable report", () => {
    const text = formatSweepReport(report, 3);
    expect(text).toContain("BREAKOUT PARAM SWEEP");
    expect(text).toContain("baseline:");
    expect(text).toContain("VERDICT:");
  });
});
