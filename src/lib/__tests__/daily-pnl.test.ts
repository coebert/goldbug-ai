import { describe, expect, it } from "vitest";
import { buildDailyPnl, groupByWeek, weekStartOf, type DailyPnlInput } from "@/lib/daily-pnl";

const day = (over: Partial<DailyPnlInput> & { date: string }): DailyPnlInput => ({
  prevDate: null,
  prevEquity: 1000,
  equity: 1000,
  netPnl: 0,
  netFlow: 0,
  fxLegs: 0,
  fees: 0,
  ...over,
});

describe("buildDailyPnl", () => {
  it("derives positions so the row adds up", () => {
    const [d] = buildDailyPnl([
      day({ date: "2026-09-04", netPnl: -7.38, fxLegs: -15.9, fees: 0.74 }),
    ]);
    expect(d!.positions).toBeCloseTo(9.26, 2);
    expect(d!.positions + d!.fxLegs - d!.fees).toBeCloseTo(d!.netPnl, 2);
  });

  it("returns newest day first and a percent of opening equity", () => {
    const days = buildDailyPnl([
      day({ date: "2026-09-01", netPnl: 10, prevEquity: 1000 }),
      day({ date: "2026-09-03", netPnl: -5, prevEquity: 1000 }),
    ]);
    expect(days.map((d) => d.date)).toEqual(["2026-09-03", "2026-09-01"]);
    expect(days[0]!.pct).toBeCloseTo(-0.5, 4);
  });

  it("has no percent without an opening equity", () => {
    const [d] = buildDailyPnl([day({ date: "2026-09-01", prevEquity: 0, netPnl: 5 })]);
    expect(d!.pct).toBeNull();
  });
});

describe("groupByWeek", () => {
  it("uses Monday as the week start", () => {
    expect(weekStartOf("2026-09-04")).toBe("2026-08-31");
    expect(weekStartOf("2026-08-31")).toBe("2026-08-31");
  });

  it("sums each component per week, newest week first", () => {
    const days = buildDailyPnl([
      day({ date: "2026-08-31", netPnl: 10, fxLegs: 2, fees: 1 }),
      day({ date: "2026-09-01", netPnl: -4, fxLegs: -3, fees: 0.5 }),
      day({ date: "2026-08-28", netPnl: 6, fxLegs: 0, fees: 0 }),
    ]);
    const weeks = groupByWeek(days);
    expect(weeks.map((w) => w.weekStart)).toEqual(["2026-08-31", "2026-08-24"]);
    expect(weeks[0]!.netPnl).toBeCloseTo(6, 2);
    expect(weeks[0]!.fxLegs).toBeCloseTo(-1, 2);
    expect(weeks[0]!.fees).toBeCloseTo(1.5, 2);
    expect(weeks[0]!.dayCount).toBe(2);
  });
});
