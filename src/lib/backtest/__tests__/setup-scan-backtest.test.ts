import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKTEST_CONFIG,
  buildVerdict,
  findSignals,
  runSetupBacktest,
} from "@/lib/backtest/setup-scan-backtest";
import type { ScanCandle } from "@/lib/setup-scan";

/**
 * Builds a history that drifts down for a long stretch (pushing price below the
 * long averages), then surges on thin volume — the archetype the scanner fires
 * on — and finally follows the supplied path.
 */
function makeHistory(after: number[]): ScanCandle[] {
  const closes: number[] = [];
  let p = 100;
  for (let i = 0; i < 220; i += 1) {
    p *= i < 170 ? 0.998 : 1.0005;
    closes.push(p);
  }
  const base = closes[closes.length - 1];
  // 5 surge sessions of ~+5% each on thin tape.
  for (let i = 0; i < 5; i += 1) closes.push(base * 1.05 ** (i + 1));
  closes.push(...after);

  return closes.map((close, i) => ({
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    close,
    high: close * 1.02,
    low: close * 0.97,
    // Thin relative volume on the surge; normal before it.
    volume: i >= 220 ? 700_000 : 1_000_000,
  }));
}

describe("setup-scan backtest", () => {
  it("locates historical signals matching the live scanner rules", () => {
    const candles = makeHistory(Array.from({ length: 30 }, (_, i) => 200 * (1 + i * 0.001)));
    const signals = findSignals("TEST", candles);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0].match.relVolume).toBeLessThan(2);
  });

  it("measures a profitable follow-through as a win net of friction", () => {
    // Strong continuation after the surge.
    const up = Array.from({ length: 40 }, (_, i) => 120 * 1.01 ** (i + 1));
    const report = runSetupBacktest([{ symbol: "UP", candles: makeHistory(up) }]);
    expect(report.signals).toBeGreaterThan(0);
    const h10 = report.chase.horizons.find((h) => h.horizon === 10)!;
    expect(h10.samples).toBeGreaterThan(0);
    expect(h10.avgNetPct).toBeGreaterThan(0);
  });

  it("marks froth: a surge that fully retraces loses net of friction", () => {
    const down = Array.from({ length: 40 }, (_, i) => 120 * 0.985 ** (i + 1));
    const report = runSetupBacktest([{ symbol: "DOWN", candles: makeHistory(down) }]);
    const h10 = report.chase.horizons.find((h) => h.horizon === 10)!;
    expect(h10.avgNetPct).toBeLessThan(0);
    expect(report.chase.stopRatePct).toBeGreaterThan(0);
    expect(report.verdict).toContain("froth");
  });

  it("skips signals whose pullback zone is never tagged", () => {
    const up = Array.from({ length: 40 }, (_, i) => 120 * 1.01 ** (i + 1));
    const report = runSetupBacktest([{ symbol: "UP", candles: makeHistory(up) }]);
    expect(report.discipline.entries + report.discipline.skipped).toBe(report.signals);
    expect(report.discipline.skipped).toBeGreaterThan(0);
  });

  it("subtracts round-trip friction from every measured return", () => {
    const flat = Array.from({ length: 40 }, () => 120);
    const candles = makeHistory(flat);
    const cheap = runSetupBacktest([{ symbol: "F", candles }], {
      ...DEFAULT_BACKTEST_CONFIG,
      frictionBps: 0,
    });
    const dear = runSetupBacktest([{ symbol: "F", candles }], {
      ...DEFAULT_BACKTEST_CONFIG,
      frictionBps: 100,
    });
    const a = cheap.chase.horizons.find((h) => h.horizon === 10)!.avgNetPct;
    const b = dear.chase.horizons.find((h) => h.horizon === 10)!.avgNetPct;
    expect(a - b).toBeCloseTo(1, 5);
  });

  it("reports insufficient evidence when there are too few signals", () => {
    const stats = {
      policy: "chase" as const,
      entries: 1,
      skipped: 0,
      horizons: [
        {
          horizon: 10,
          samples: 1,
          winRatePct: 100,
          avgNetPct: 5,
          medianNetPct: 5,
          bestPct: 5,
          worstPct: 5,
          payoff: null,
          expectancyPct: 5,
        },
      ],
      avgMaxAdversePct: 0,
      stopRatePct: 0,
    };
    expect(buildVerdict(stats, stats, 10)).toContain("Not enough historical signals");
  });
});
