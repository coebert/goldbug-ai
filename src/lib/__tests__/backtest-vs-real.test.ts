import { describe, expect, it } from "vitest";
import { compareBacktestToReal, curveStats, verdictFor } from "@/lib/backtest-vs-real";

const days = (n: number) =>
  Array.from({ length: n }, (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`);

describe("compareBacktestToReal", () => {
  it("rebases both curves to 100 on the first shared day", () => {
    const d = days(3);
    const c = compareBacktestToReal({
      backtest: d.map((date, i) => ({ date, value: 1000 * (1 + i * 0.01) })),
      real: d.map((date, i) => ({ date, value: 50_000 * (1 + i * 0.005) })),
    });
    expect(c.points[0].backtest).toBeCloseTo(100, 6);
    expect(c.points[0].real).toBeCloseTo(100, 6);
    expect(c.points[2].backtest).toBeCloseTo(102, 6);
    expect(c.points[2].real).toBeCloseTo(101, 6);
    expect(c.points[2].gap).toBeCloseTo(-1, 6);
  });

  it("reports the return gap in percent and in money on the real capital base", () => {
    const d = days(2);
    const c = compareBacktestToReal({
      backtest: [
        { date: d[0], value: 100 },
        { date: d[1], value: 110 }, // +10%
      ],
      real: [
        { date: d[0], value: 10_000 },
        { date: d[1], value: 10_600 }, // +6%
      ],
    });
    expect(c.backtestStats.totalReturnPct).toBeCloseTo(10, 6);
    expect(c.realStats.totalReturnPct).toBeCloseTo(6, 6);
    expect(c.returnGapPct).toBeCloseTo(-4, 6);
    expect(c.realPnl).toBeCloseTo(600, 6);
    expect(c.backtestPnl).toBeCloseTo(1000, 6);
    expect(c.pnlGap).toBeCloseTo(-400, 6);
    expect(c.startEquity).toBe(10_000);
  });

  it("only compares overlapping days and counts what it dropped", () => {
    const c = compareBacktestToReal({
      backtest: [
        { date: "2026-07-01", value: 100 },
        { date: "2026-08-01", value: 100 },
        { date: "2026-08-02", value: 105 },
      ],
      real: [
        { date: "2026-08-01", value: 200 },
        { date: "2026-08-02", value: 210 },
        { date: "2026-09-01", value: 250 },
      ],
    });
    expect(c.days).toBe(2);
    expect(c.from).toBe("2026-08-01");
    expect(c.to).toBe("2026-08-02");
    expect(c.droppedBacktestDays).toBe(1);
    expect(c.droppedRealDays).toBe(1);
  });

  it("counts only fees inside the shared window, in bps of starting equity", () => {
    const c = compareBacktestToReal({
      backtest: [
        { date: "2026-08-01", value: 100 },
        { date: "2026-08-02", value: 101 },
      ],
      real: [
        { date: "2026-08-01", value: 10_000 },
        { date: "2026-08-02", value: 10_050 },
      ],
      fees: [
        { date: "2026-07-30T09:00:00Z", amount: 999 }, // before the window
        { date: "2026-08-01T09:00:00Z", amount: 20 },
        { date: "2026-08-02T15:30:00Z", amount: -5 }, // sign-agnostic
        { date: "2026-09-02T15:30:00Z", amount: 999 }, // after the window
      ],
    });
    expect(c.fees).toBeCloseTo(25, 6);
    expect(c.feesBps).toBeCloseTo(25, 6);
  });

  it("attributes fees to a shortfall only, never to outperformance", () => {
    const behind = compareBacktestToReal({
      backtest: [
        { date: "2026-08-01", value: 100 },
        { date: "2026-08-02", value: 110 },
      ],
      real: [
        { date: "2026-08-01", value: 1000 },
        { date: "2026-08-02", value: 1050 },
      ],
      fees: [{ date: "2026-08-02", amount: 25 }],
    });
    expect(behind.pnlGap).toBeCloseTo(-50, 6);
    expect(behind.feeShareOfGap).toBeCloseTo(0.5, 6);

    const ahead = compareBacktestToReal({
      backtest: [
        { date: "2026-08-01", value: 100 },
        { date: "2026-08-02", value: 101 },
      ],
      real: [
        { date: "2026-08-01", value: 1000 },
        { date: "2026-08-02", value: 1030 },
      ],
      fees: [{ date: "2026-08-02", amount: 25 }],
    });
    expect(ahead.pnlGap).toBeGreaterThan(0);
    expect(ahead.feeShareOfGap).toBeNull();
  });

  it("caps the fee share at 1 when fees exceed the shortfall", () => {
    const c = compareBacktestToReal({
      backtest: [
        { date: "2026-08-01", value: 100 },
        { date: "2026-08-02", value: 101 },
      ],
      real: [
        { date: "2026-08-01", value: 1000 },
        { date: "2026-08-02", value: 1005 },
      ],
      fees: [{ date: "2026-08-02", amount: 500 }],
    });
    expect(c.feeShareOfGap).toBe(1);
  });

  it("keeps the last value when a day has several points", () => {
    const c = compareBacktestToReal({
      backtest: [
        { date: "2026-08-01T09:00:00Z", value: 100 },
        { date: "2026-08-02T09:00:00Z", value: 101 },
        { date: "2026-08-02T16:00:00Z", value: 104 },
      ],
      real: [
        { date: "2026-08-01", value: 1000 },
        { date: "2026-08-02", value: 1010 },
      ],
    });
    expect(c.days).toBe(2);
    expect(c.backtestStats.totalReturnPct).toBeCloseTo(4, 6);
  });

  it("returns an empty comparison when there is no overlap", () => {
    const c = compareBacktestToReal({
      backtest: [{ date: "2026-08-01", value: 100 }],
      real: [{ date: "2026-09-01", value: 100 }],
    });
    expect(c.days).toBe(0);
    expect(c.points).toEqual([]);
    expect(verdictFor(c)).toMatch(/Not enough overlapping days/);
  });

  it("ignores non-finite values instead of poisoning the curve", () => {
    const c = compareBacktestToReal({
      backtest: [
        { date: "2026-08-01", value: 100 },
        { date: "2026-08-02", value: Number.NaN },
        { date: "2026-08-03", value: 102 },
      ],
      real: [
        { date: "2026-08-01", value: 1000 },
        { date: "2026-08-02", value: 1005 },
        { date: "2026-08-03", value: 1010 },
      ],
    });
    expect(c.days).toBe(2);
    expect(c.points.map((p) => p.date)).toEqual(["2026-08-01", "2026-08-03"]);
  });
});

describe("curveStats", () => {
  it("measures drawdown, extremes and up-day share", () => {
    const s = curveStats([100, 110, 88, 99]);
    expect(s.totalReturnPct).toBeCloseTo(-1, 6);
    expect(s.maxDrawdownPct).toBeLessThan(0);
    expect(s.maxDrawdownPct).toBeCloseTo(-20, 6);
    expect(s.bestDayPct).toBeCloseTo(10, 6);
    expect(s.worstDayPct).toBeCloseTo(-20, 6);
    expect(s.upDayPct).toBeCloseTo((2 / 3) * 100, 6);
  });

  it("is neutral on a series too short to have a step", () => {
    expect(curveStats([100]).totalReturnPct).toBe(0);
    expect(curveStats([]).upDayPct).toBeNull();
  });
});

describe("verdictFor", () => {
  it("calls out a shortfall dominated by broker costs", () => {
    const c = compareBacktestToReal({
      backtest: [
        { date: "2026-08-01", value: 100 },
        { date: "2026-08-02", value: 110 },
      ],
      real: [
        { date: "2026-08-01", value: 1000 },
        { date: "2026-08-02", value: 1010 },
      ],
      fees: [{ date: "2026-08-02", amount: 80 }],
    });
    expect(verdictFor(c)).toMatch(/behind the backtest — mostly broker costs/);
  });

  it("says so when live is ahead", () => {
    const c = compareBacktestToReal({
      backtest: [
        { date: "2026-08-01", value: 100 },
        { date: "2026-08-02", value: 101 },
      ],
      real: [
        { date: "2026-08-01", value: 1000 },
        { date: "2026-08-02", value: 1050 },
      ],
    });
    expect(verdictFor(c)).toMatch(/ahead of the backtest/);
  });
});
