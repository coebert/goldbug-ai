import { describe, expect, it } from "vitest";
import { armHeadlineMetrics } from "@/lib/backtest/arm-metrics";
import type { ArmResult } from "@/lib/backtest/insider-nudge-replay";

function arm(over: Partial<ArmResult>): ArmResult {
  return {
    label: "Test",
    curve: [
      { date: "2024-01-01", equity: 100, cost: 0, positions: 0 },
      { date: "2026-01-01", equity: 121, cost: 0, positions: 1 },
    ],
    finalEquity: 121,
    totalReturnPct: 21,
    maxDrawdownPct: 5,
    sharpe: 1,
    totalCost: 0,
    trades: 4,
    avgPositions: 1,
    avgGross: 0.5,
    var95Pct: 1,
    cvar95Pct: 2,
    volAnnPct: 10,
    ...over,
  };
}

const ep = (contributionPct: number, open = false) => ({
  symbol: "AAA",
  from: "2024-02-01",
  to: open ? null : "2024-03-01",
  days: 20,
  peakWeight: 0.1,
  contributionPct,
  open,
});

describe("armHeadlineMetrics", () => {
  it("annualises return over the curve span", () => {
    const m = armHeadlineMetrics(arm({}));
    expect(m.years).toBeCloseTo(2, 1);
    expect(m.cagrPct).toBeCloseTo(10, 0);
  });

  it("reports raw return when the tape is under a year", () => {
    const m = armHeadlineMetrics(
      arm({
        curve: [
          { date: "2026-01-01", equity: 100, cost: 0, positions: 0 },
          { date: "2026-04-01", equity: 110, cost: 0, positions: 1 },
        ],
        totalReturnPct: 10,
      }),
    );
    expect(m.cagrPct).toBe(10);
  });

  it("computes win rate from closed positions only", () => {
    const m = armHeadlineMetrics(arm({ episodes: [ep(3), ep(-1), ep(2), ep(5, true)] }));
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(1);
    expect(m.winRatePct).toBeCloseTo(66.67, 1);
    expect(m.winRateFromDays).toBe(false);
    expect(m.profitFactor).toBeCloseTo(5, 5);
  });

  it("falls back to winning days when no episodes are tracked", () => {
    const m = armHeadlineMetrics(
      arm({
        curve: [
          { date: "2024-01-01", equity: 100, cost: 0, positions: 0 },
          { date: "2024-01-02", equity: 101, cost: 0, positions: 1 },
          { date: "2024-01-03", equity: 100.5, cost: 0, positions: 1 },
          { date: "2026-01-01", equity: 121, cost: 0, positions: 1 },
        ],
      }),
    );
    expect(m.winRateFromDays).toBe(true);
    expect(m.winRatePct).toBeCloseTo(66.67, 1);
  });

  it("returns null win rate on an empty arm", () => {
    const m = armHeadlineMetrics(arm({ curve: [], episodes: [] }));
    expect(m.winRatePct).toBeNull();
    expect(m.cagrPct).toBeNull();
  });
});
