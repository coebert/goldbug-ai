import { describe, it, expect } from "vitest";
import { alignToIndex, compareArmToIndex, indexComparisonReport } from "../index-benchmark";
import type { ArmResult } from "../thesis-break-replay";

function day(i: number): string {
  return new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
}

function arm(values: number[]): ArmResult {
  return {
    arm: "thesis-break",
    equity: values.map((v, i) => ({ date: day(i), value: v })),
    totalReturnPct: (values[values.length - 1]! / values[0]! - 1) * 100,
    maxDrawdownPct: 0,
    winRatePct: 0,
    avgLossPct: 0,
    trades: [],
    exitMix: {},
    thesisEvents: [],
    signalCounts: {},
    actionMix: { trim: 0, close: 0 },
  } as unknown as ArmResult;
}

describe("index benchmark", () => {
  const index = {
    symbol: "SPY",
    bars: Array.from({ length: 10 }, (_, i) => ({ date: day(i), close: 100 + i })),
  };

  it("aligns the arm curve onto index closes, carrying holidays forward", () => {
    const a = arm([1000, 1010, 1020]);
    // Drop one index bar: the previous close must carry forward.
    const gappy = { symbol: "SPY", bars: [index.bars[0]!, index.bars[2]!] };
    const { dates, idx } = alignToIndex(a.equity, gappy);
    expect(dates).toEqual([day(0), day(1), day(2)]);
    expect(idx).toEqual([100, 100, 102]);
  });

  it("scores an arm that beats the index", () => {
    const a = arm(Array.from({ length: 10 }, (_, i) => 1000 * (1 + i * 0.02)));
    const cmp = compareArmToIndex(a, index)!;
    expect(cmp.indexSymbol).toBe("SPY");
    expect(cmp.indexReturnPct).toBeCloseTo(9, 6);
    expect(cmp.excessReturnPct).toBeGreaterThan(0);
    expect(cmp.outcome).toBe("beats");
    expect(cmp.correlation).toBeGreaterThan(0.9);
    expect(cmp.days).toBe(10);
  });

  it("scores an arm that lags the index and reports drawdown delta", () => {
    const a = arm([1000, 990, 950, 940, 930, 935, 930, 925, 920, 915]);
    const cmp = compareArmToIndex(a, index)!;
    expect(cmp.outcome).toBe("lags");
    expect(cmp.excessReturnPct).toBeLessThan(0);
    expect(cmp.armMaxDrawdownPct).toBeGreaterThan(0);
    expect(cmp.indexMaxDrawdownPct).toBe(0);
    expect(cmp.drawdownDeltaPct).toBeCloseTo(cmp.armMaxDrawdownPct, 6);
  });

  it("returns null without enough overlapping history", () => {
    expect(compareArmToIndex(arm([1000, 1010]), { symbol: "SPY", bars: [] })).toBeNull();
  });

  it("formats a report table", () => {
    const cmp = compareArmToIndex(arm([1000, 1100, 1200, 1300]), index)!;
    const lines = indexComparisonReport([cmp]);
    expect(lines[0]).toContain("SPY");
    expect(lines.join("\n")).toContain("thesis-break");
  });
});
