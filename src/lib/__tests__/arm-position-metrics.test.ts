// Per-arm position metrics: holding time, profit factor, loss streaks.

import { describe, expect, it } from "vitest";
import { armHeadlineMetrics } from "@/lib/backtest/arm-metrics";
import type { ArmEpisode, ArmResult } from "@/lib/backtest/insider-nudge-replay";

const ep = (
  symbol: string,
  from: string,
  to: string | null,
  days: number,
  contributionPct: number,
): ArmEpisode => ({
  symbol,
  from,
  to,
  days,
  peakWeight: 0.1,
  contributionPct,
  open: to == null,
});

function arm(episodes: ArmEpisode[]): ArmResult {
  return {
    label: "Test",
    curve: [
      { date: "2024-01-01", equity: 100 },
      { date: "2025-01-01", equity: 110 },
    ],
    totalReturnPct: 10,
    maxDrawdownPct: -5,
    volAnnPct: 12,
    sharpe: 0.8,
    episodes,
  } as unknown as ArmResult;
}

describe("armHeadlineMetrics — position metrics", () => {
  it("computes holding time, profit factor and expectancy from closed episodes", () => {
    const m = armHeadlineMetrics(
      arm([
        ep("AAA", "2024-01-02", "2024-01-12", 10, 2),
        ep("BBB", "2024-02-01", "2024-02-05", 4, -1),
        ep("CCC", "2024-03-01", "2024-03-31", 30, 4),
        ep("DDD", "2024-04-01", null, 12, 1),
      ]),
    );

    expect(m.closedTrades).toBe(3);
    expect(m.openTrades).toBe(1);
    expect(m.winRatePct).toBeCloseTo((2 / 3) * 100, 6);
    expect(m.winRateFromDays).toBe(false);
    // gross win 6, gross loss 1
    expect(m.profitFactor).toBeCloseTo(6, 6);
    expect(m.expectancyPct).toBeCloseTo((2 - 1 + 4) / 3, 6);
    expect(m.avgHoldDays).toBeCloseTo((10 + 4 + 30) / 3, 1);
    expect(m.medianHoldDays).toBe(10);
    expect(m.maxHoldDays).toBe(30);
  });

  it("counts the longest run of consecutive losses by exit date", () => {
    // Deliberately out of order: streaks must follow exits, not array order.
    const m = armHeadlineMetrics(
      arm([
        ep("E", "2024-05-01", "2024-05-10", 9, 3),
        ep("B", "2024-02-01", "2024-02-10", 9, -1),
        ep("A", "2024-01-01", "2024-01-10", 9, 2),
        ep("D", "2024-04-01", "2024-04-10", 9, -3),
        ep("C", "2024-03-01", "2024-03-10", 9, -2),
      ]),
    );
    expect(m.maxConsecutiveLosses).toBe(3);
    expect(m.maxConsecutiveWins).toBe(1);
  });

  it("treats flat exits as neither win nor loss and never breaks a run", () => {
    const m = armHeadlineMetrics(
      arm([
        ep("A", "2024-01-01", "2024-01-10", 9, -1),
        ep("B", "2024-02-01", "2024-02-10", 9, 0),
        ep("C", "2024-03-01", "2024-03-10", 9, -1),
      ]),
    );
    expect(m.maxConsecutiveLosses).toBe(2);
    expect(m.wins).toBe(0);
  });

  it("returns nulls for position metrics when the arm tracks no episodes", () => {
    const m = armHeadlineMetrics(arm([]));
    expect(m.closedTrades).toBe(0);
    expect(m.avgHoldDays).toBeNull();
    expect(m.maxConsecutiveLosses).toBeNull();
    expect(m.expectancyPct).toBeNull();
    expect(m.profitFactor).toBeNull();
  });

  it("never emits non-finite position metrics when every close is a winner", () => {
    const m = armHeadlineMetrics(
      arm([ep("A", "2024-01-01", "2024-01-10", 9, 2), ep("B", "2024-02-01", "2024-02-10", 9, 1)]),
    );
    // No losses → profit factor is undefined rather than Infinity.
    expect(m.profitFactor).toBeNull();
    expect(m.maxConsecutiveLosses).toBe(0);
    expect(Number.isFinite(m.avgHoldDays!)).toBe(true);
  });
});
