import { describe, it, expect } from "vitest";
import {
  atrAt,
  simulateTrade,
  regimeTimeline,
  runBreakoutBacktest,
  formatBreakoutBacktestReport,
  DEFAULT_BREAKOUT_BACKTEST_CONFIG,
  type BacktestBar,
  type SymbolBars,
} from "@/lib/breakout-backtest";

function d(i: number): string {
  const base = Date.UTC(2024, 0, 1) + i * 86400000;
  return new Date(base).toISOString().slice(0, 10);
}

function bar(i: number, close: number, spreadPct = 0.01, volume = 1000): BacktestBar {
  return {
    date: d(i),
    high: close * (1 + spreadPct),
    low: close * (1 - spreadPct),
    close,
    volume,
  };
}

/** Flat base then a volume-backed expansion that keeps running. */
function breakoutSeries(n = 200): BacktestBar[] {
  const bars: BacktestBar[] = [];
  for (let i = 0; i < n; i++) {
    if (i < 150) {
      // Tight base with a deterministic wobble.
      bars.push(bar(i, 100 + (i % 5) * 0.2, 0.004, 1000));
    } else {
      bars.push(bar(i, 101 + (i - 149) * 1.5, 0.01, 4000));
    }
  }
  return bars;
}

describe("atrAt", () => {
  it("returns null before enough history", () => {
    const bars = breakoutSeries(30);
    expect(atrAt(bars, 5)).toBeNull();
  });

  it("is positive on real ranges", () => {
    const bars = breakoutSeries(60);
    const atr = atrAt(bars, 40);
    expect(atr).not.toBeNull();
    expect(atr!).toBeGreaterThan(0);
  });
});

describe("simulateTrade", () => {
  const cfg = { horizonBars: 5, stopAtr: 1, targetAtr: 2, costBps: 0 };

  it("exits a long at the target when price runs up", () => {
    const bars: BacktestBar[] = [];
    for (let i = 0; i < 10; i++) bars.push(bar(i, 100 + i * 2, 0.005));
    const r = simulateTrade(bars, 2, "long", 1, cfg);
    expect(r.exitReason).toBe("target");
    expect(r.returnPct).toBeGreaterThan(0);
    expect(r.maxAdversePct).toBeLessThanOrEqual(0);
  });

  it("exits a long at the stop when price falls", () => {
    const bars: BacktestBar[] = [];
    for (let i = 0; i < 10; i++) bars.push(bar(i, 100 - i * 2, 0.005));
    const r = simulateTrade(bars, 2, "long", 1, cfg);
    expect(r.exitReason).toBe("stop");
    expect(r.returnPct).toBeLessThan(0);
  });

  it("prefers the stop when a bar touches both levels", () => {
    const bars: BacktestBar[] = [
      bar(0, 100, 0.001),
      bar(1, 100, 0.001),
      { date: d(2), high: 110, low: 90, close: 105 },
    ];
    const r = simulateTrade(bars, 1, "long", 2, cfg);
    expect(r.exitReason).toBe("stop");
  });

  it("mirrors the sign for shorts", () => {
    const bars: BacktestBar[] = [];
    for (let i = 0; i < 10; i++) bars.push(bar(i, 100 - i * 2, 0.005));
    const long = simulateTrade(bars, 2, "long", 50, { ...cfg, stopAtr: 0, targetAtr: 0 });
    const short = simulateTrade(bars, 2, "short", 50, { ...cfg, stopAtr: 0, targetAtr: 0 });
    expect(short.returnPct).toBeCloseTo(-long.returnPct, 6);
  });

  it("charges the round-trip cost", () => {
    const bars: BacktestBar[] = [];
    for (let i = 0; i < 10; i++) bars.push(bar(i, 100, 0.0001));
    const r = simulateTrade(bars, 2, "long", 5, { ...cfg, stopAtr: 0, targetAtr: 0, costBps: 25 });
    expect(r.returnPct).toBeCloseTo(-0.25, 6);
  });

  it("exits on the horizon when no level is touched", () => {
    const bars: BacktestBar[] = [];
    for (let i = 0; i < 20; i++) bars.push(bar(i, 100, 0.001));
    const r = simulateTrade(bars, 2, "long", 20, cfg);
    expect(r.exitReason).toBe("horizon");
    expect(r.barsHeld).toBe(5);
  });
});

describe("regimeTimeline", () => {
  it("labels a steady uptrend bull and a crash bear", () => {
    const up: SymbolBars = {
      symbol: "UP",
      bars: Array.from({ length: 120 }, (_, i) => bar(i, 100 * 1.008 ** i)),
    };
    const timeline = regimeTimeline([up]);
    expect(timeline.get(d(119))).toBe("bull");

    const down: SymbolBars = {
      symbol: "DOWN",
      bars: Array.from({ length: 120 }, (_, i) => bar(i, 100 * 0.985 ** i)),
    };
    expect(regimeTimeline([down]).get(d(119))).toBe("bear");
  });

  it("returns an empty map for empty input", () => {
    expect(regimeTimeline([]).size).toBe(0);
  });
});

describe("runBreakoutBacktest", () => {
  const trending: SymbolBars = { symbol: "TREND", bars: breakoutSeries(220) };

  it("emits signals with a regime label and net returns", () => {
    const report = runBreakoutBacktest([trending], { warmupBars: 80 });
    expect(report.barsScanned).toBeGreaterThan(0);
    expect(report.trades.length).toBeGreaterThan(0);
    for (const t of report.trades) {
      expect(["bull", "bear", "sideways"]).toContain(t.regime);
      expect(["confirmed", "pending", "extended", "failed"]).toContain(t.cohort);
      expect(Number.isFinite(t.returnPct)).toBe(true);
      expect(t.maxAdversePct).toBeLessThanOrEqual(0);
      expect(t.maxFavourablePct).toBeGreaterThanOrEqual(0);
    }
  });

  it("takes confirmed upside breakouts long and failed ones short", () => {
    const report = runBreakoutBacktest([trending], { warmupBars: 80 });
    for (const t of report.trades) {
      const expected =
        t.cohort === "failed"
          ? t.direction === "up"
            ? "short"
            : "long"
          : t.direction === "up"
            ? "long"
            : "short";
      expect(t.side).toBe(expected);
    }
  });

  it("finds a profitable confirmed cohort on a clean trending breakout", () => {
    const report = runBreakoutBacktest([trending], { warmupBars: 80, costBps: 0 });
    const confirmed = report.stats.find((s) => s.cohort === "confirmed" && s.regime === "all")!;
    expect(confirmed.trades).toBeGreaterThan(0);
    expect(confirmed.avgReturnPct).toBeGreaterThan(0);
    expect(confirmed.winRatePct).toBeGreaterThan(50);
  });

  it("respects the cooldown so one breakout is not counted many times", () => {
    const dense = runBreakoutBacktest([trending], { warmupBars: 80, cooldownBars: 0 });
    const spaced = runBreakoutBacktest([trending], { warmupBars: 80, cooldownBars: 20 });
    expect(spaced.trades.length).toBeLessThanOrEqual(dense.trades.length);
    const dates = spaced.trades.filter((t) => t.symbol === "TREND").map((t) => t.date);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("is deterministic", () => {
    const a = runBreakoutBacktest([trending], { warmupBars: 80 });
    const b = runBreakoutBacktest([trending], { warmupBars: 80 });
    expect(JSON.stringify(a.stats)).toBe(JSON.stringify(b.stats));
  });

  it("skips series shorter than the warmup", () => {
    const report = runBreakoutBacktest([{ symbol: "SHORT", bars: breakoutSeries(40) }], {
      warmupBars: 80,
    });
    expect(report.trades).toHaveLength(0);
    expect(report.edge.verdict).toBe("insufficient_data");
  });

  it("reports insufficient_data rather than a fake verdict on thin samples", () => {
    const report = runBreakoutBacktest([trending], { warmupBars: 80 });
    if (report.trades.length < 20) expect(report.edge.verdict).toBe("insufficient_data");
    expect(report.edge.notes.length).toBeGreaterThan(0);
  });

  it("costs drag every cohort's average return", () => {
    const free = runBreakoutBacktest([trending], { warmupBars: 80, costBps: 0 });
    const costly = runBreakoutBacktest([trending], { warmupBars: 80, costBps: 100 });
    const a = free.stats.find((s) => s.cohort === "all" && s.regime === "all")!;
    const b = costly.stats.find((s) => s.cohort === "all" && s.regime === "all")!;
    if (a.trades > 0) expect(b.avgReturnPct).toBeLessThan(a.avgReturnPct);
  });

  it("keeps drawdown non-positive and win/loss counts consistent", () => {
    const report = runBreakoutBacktest([trending], { warmupBars: 80 });
    for (const s of report.stats) {
      expect(s.maxDrawdownPct).toBeLessThanOrEqual(0);
      expect(s.wins + s.losses).toBe(s.trades);
      if (s.trades) expect(s.winRatePct).toBeCloseTo((s.wins / s.trades) * 100, 6);
    }
  });

  it("splits every cohort total across the three regime buckets", () => {
    const report = runBreakoutBacktest([trending], { warmupBars: 80 });
    for (const cohort of ["confirmed", "pending", "extended", "failed"] as const) {
      const all = report.stats.find((s) => s.cohort === cohort && s.regime === "all")!;
      const parts = (["bull", "bear", "sideways"] as const)
        .map((r) => report.stats.find((s) => s.cohort === cohort && s.regime === r)!.trades)
        .reduce((a, b) => a + b, 0);
      expect(parts).toBe(all.trades);
    }
  });

  it("formats a readable text report", () => {
    const report = runBreakoutBacktest([trending], { warmupBars: 80 });
    const text = formatBreakoutBacktestReport(report);
    expect(text).toContain("BREAKOUT SIGNAL BACKTEST");
    expect(text).toContain("VERDICT:");
  });

  it("exposes sane defaults", () => {
    expect(DEFAULT_BREAKOUT_BACKTEST_CONFIG.horizonBars).toBeGreaterThan(0);
    expect(DEFAULT_BREAKOUT_BACKTEST_CONFIG.stopAtr).toBeGreaterThan(0);
    expect(DEFAULT_BREAKOUT_BACKTEST_CONFIG.costBps).toBeGreaterThanOrEqual(0);
  });
});
