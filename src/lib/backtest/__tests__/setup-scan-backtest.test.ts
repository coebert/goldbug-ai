import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKTEST_CONFIG,
  buildVerdict,
  findSignals,
  runSetupBacktest,
} from "@/lib/backtest/setup-scan-backtest";
import type { ScanCandle } from "@/lib/setup-scan";

/**
 * Long uptrend, a sharp dip below the 50d average, then a thin-tape surge that
 * reclaims both averages — the archetype the live scanner fires on. `after`
 * supplies the follow-through path used to score the trade.
 */
function makeHistory(after: number[]): ScanCandle[] {
  const closes: number[] = [];
  let p = 100;
  for (let i = 0; i < 200; i += 1) {
    p *= 1.003;
    closes.push(p);
  }
  for (let i = 0; i < 12; i += 1) {
    p *= 0.975;
    closes.push(p);
  }
  for (let i = 0; i < 5; i += 1) {
    p *= 1.07;
    closes.push(p);
  }
  closes.push(...after);

  return closes.map((close, i) => ({
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    close,
    high: close * 1.02,
    low: close * 0.97,
    // Thin relative volume across the surge; normal beforehand.
    volume: i >= 212 ? 700_000 : 1_000_000,
  }));
}

/** Signal fires at index 216 with price ~188 and a 140-172 pullback zone. */
const SIGNAL_PRICE = 188.4;

describe("setup-scan backtest", () => {
  it("locates historical signals matching the live scanner rules", () => {
    const signals = findSignals("TEST", makeHistory(Array.from({ length: 30 }, () => SIGNAL_PRICE)));
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0].match.relVolume).toBeLessThan(2);
    expect(signals[0].match.annualVolPct).toBeGreaterThan(60);
  });

  it("measures a profitable follow-through as a win net of friction", () => {
    const up = Array.from({ length: 40 }, (_, i) => SIGNAL_PRICE * 1.01 ** (i + 1));
    const report = runSetupBacktest([{ symbol: "UP", candles: makeHistory(up) }]);
    expect(report.signals).toBeGreaterThan(0);
    const h10 = report.chase.horizons.find((h) => h.horizon === 10)!;
    expect(h10.samples).toBeGreaterThan(0);
    expect(h10.avgNetPct).toBeGreaterThan(0);
    expect(h10.winRatePct).toBe(100);
  });

  it("marks froth: a surge that retraces loses net of friction", () => {
    const down = Array.from({ length: 40 }, (_, i) => SIGNAL_PRICE * 0.97 ** (i + 1));
    const report = runSetupBacktest([{ symbol: "DOWN", candles: makeHistory(down) }]);
    const h10 = report.chase.horizons.find((h) => h.horizon === 10)!;
    expect(h10.avgNetPct).toBeLessThan(0);
    expect(report.chase.stopRatePct).toBeGreaterThan(0);
  });

  it("skips signals whose pullback zone is never tagged", () => {
    const up = Array.from({ length: 40 }, (_, i) => SIGNAL_PRICE * 1.01 ** (i + 1));
    const report = runSetupBacktest([{ symbol: "UP", candles: makeHistory(up) }]);
    expect(report.discipline.entries + report.discipline.skipped).toBe(report.signals);
    expect(report.discipline.entries).toBe(0);
    expect(report.discipline.skipped).toBeGreaterThan(0);
  });

  it("enters on a pullback into the reclaimed averages and holds the level", () => {
    // Drift back into the 140-172 zone, then recover.
    const path = [180, 172, 165, 168, 175, 182, 190, 196, 200, 205, 210, 215];
    const report = runSetupBacktest([{ symbol: "PB", candles: makeHistory(path) }], {
      ...DEFAULT_BACKTEST_CONFIG,
      horizons: [5],
    });
    expect(report.discipline.entries).toBe(1);
    const h5 = report.discipline.horizons.find((h) => h.horizon === 5)!;
    expect(h5.avgNetPct).toBeGreaterThan(0);
  });

  it("subtracts round-trip friction from every measured return", () => {
    const flat = Array.from({ length: 40 }, () => SIGNAL_PRICE);
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

  it("calls a negative-expectancy pattern froth once the sample is large enough", () => {
    const losing = {
      policy: "chase" as const,
      entries: 12,
      skipped: 0,
      horizons: [
        {
          horizon: 10,
          samples: 12,
          winRatePct: 33,
          avgNetPct: -2.4,
          medianNetPct: -3,
          bestPct: 6,
          worstPct: -14,
          payoff: 0.6,
          expectancyPct: -2.4,
        },
      ],
      avgMaxAdversePct: -9,
      stopRatePct: 50,
    };
    const verdict = buildVerdict(losing, { ...losing, entries: 6 }, 10);
    expect(verdict).toContain("froth");
    expect(verdict).toContain("do not buy the surge bar");
  });
});

describe("per-match trade outcomes", () => {
  const up = Array.from({ length: 40 }, (_, i) => SIGNAL_PRICE * 1.01 ** (i + 1));

  it("reports the exact exit bar, dates and net return for each horizon", () => {
    const report = runSetupBacktest([{ symbol: "UP", candles: makeHistory(up) }]);
    const chase = report.trades.find((t) => t.policy === "chase")!;
    expect(chase.entryDate).toBe(chase.signalDate);
    for (const h of DEFAULT_BACKTEST_CONFIG.horizons) {
      const exit = chase.exits[h];
      if (!exit) continue;
      expect(exit.barsHeld).toBe(h);
      expect(exit.exitDate > chase.entryDate!).toBe(true);
      expect(exit.netPct).toBeCloseTo(
        exit.grossPct - DEFAULT_BACKTEST_CONFIG.frictionBps / 100,
        6,
      );
      expect(exit.netPct).toBeCloseTo(chase.netReturnPct[h]!, 6);
      expect(exit.maxFavourablePct).toBeGreaterThanOrEqual(exit.maxAdversePct);
    }
    const five = chase.exits[5]!;
    const twenty = chase.exits[20]!;
    expect(twenty.exitDate > five.exitDate).toBe(true);
    expect(twenty.grossPct).toBeGreaterThan(five.grossPct);
  });

  it("flags invalidation with the date the level broke", () => {
    const down = Array.from({ length: 40 }, (_, i) => SIGNAL_PRICE * 0.94 ** (i + 1));
    const report = runSetupBacktest([{ symbol: "DOWN", candles: makeHistory(down) }]);
    const chase = report.trades.find((t) => t.policy === "chase")!;
    const exit = chase.exits[20] ?? chase.exits[10] ?? chase.exits[5]!;
    expect(exit.invalidated).toBe(true);
    expect(exit.invalidationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(exit.invalidationDate! <= exit.exitDate).toBe(true);
    expect(exit.netPct).toBeLessThan(0);
    expect(chase.stoppedOut).toBe(true);
  });

  it("explains why a disciplined entry never happened", () => {
    const report = runSetupBacktest([{ symbol: "UP", candles: makeHistory(up) }]);
    const skipped = report.trades.find((t) => t.policy === "discipline" && t.entryPrice == null);
    if (skipped) {
      expect(skipped.noEntryReason).toBeTruthy();
      expect(skipped.exits[10]).toBeNull();
    }
  });
});
