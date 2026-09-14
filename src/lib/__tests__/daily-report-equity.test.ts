import { describe, expect, it } from "vitest";

import {
  assessPersistence,
  buildEquitySummary,
  dailyVolPct,
  moveConcentrationPct,
  runLength,
  windowTotal,
  type EquityChangeRow,
} from "@/lib/daily-report-equity";

function row(date: string, pnl: number, prevEquity = 10_000): EquityChangeRow {
  return {
    date,
    prevDate: null,
    prevEquity,
    equity: prevEquity + pnl,
    pnl,
    netFlow: 0,
    pct: (pnl / prevEquity) * 100,
  };
}

const week: EquityChangeRow[] = [
  row("2026-09-08", 20),
  row("2026-09-09", -15),
  row("2026-09-10", 30),
  row("2026-09-11", 25),
  row("2026-09-12", 40),
];

describe("daily report equity", () => {
  it("totals a window and measures it against its opening equity", () => {
    const t = windowTotal(week, "2026-09-12", 7);
    expect(t?.pnl).toBe(100);
    expect(t?.days).toBe(5);
    expect(t?.pct).toBeCloseTo(1, 5);
  });

  it("ignores days after the report date", () => {
    expect(windowTotal(week, "2026-09-10", 7)?.pnl).toBe(35);
  });

  it("counts the current run of same-direction days", () => {
    expect(runLength(week, "2026-09-12")).toEqual({ direction: "up", days: 3 });
  });

  it("derives a daily volatility and a concentration share", () => {
    expect(dailyVolPct(week)).toBeGreaterThan(0);
    expect(
      moveConcentrationPct([
        { symbol: "A", contribution: 80, pricePct: 1 },
        { symbol: "B", contribution: -20, pricePct: -1 },
      ]),
    ).toBe(80);
  });

  it("calls a steady multi-day run more likely to continue", () => {
    const p = assessPersistence({ rows: week, endDate: "2026-09-12", movers: [], regime: null });
    expect(p.verdict).toBe("likely_to_continue");
    expect(p.text).toMatch(/not a promise/i);
  });

  it("calls an outsized one-day jump likely to fade", () => {
    const spike = [...week, row("2026-09-13", 900)];
    const p = assessPersistence({ rows: spike, endDate: "2026-09-13", movers: [], regime: null });
    expect(p.verdict).toBe("likely_to_fade");
  });

  it("says plainly when there is no measured change", () => {
    const summary = buildEquitySummary({
      currency: "GBP",
      hasData: false,
      equity: null,
      day: null,
      week: null,
      month: null,
      split: { positions: null, fxLegs: null, fees: null },
      helped: [],
      hurt: [],
      persistence: assessPersistence({ rows: [], endDate: "2026-09-12", movers: [], regime: null }),
      reaction: {
        drawdownPct: null,
        drawdownLimitPct: null,
        dailyLossLimitPct: null,
        haltActive: false,
        haltReason: null,
        cashPct: null,
        targetPerNamePct: null,
        dailyNotionalLimit: null,
        notes: [],
      },
    });
    expect(summary).toMatch(/no measured account-value change/i);
  });

  it("explains the move, the movers and the guardrails it feeds", () => {
    const summary = buildEquitySummary({
      currency: "GBP",
      hasData: true,
      equity: 10_100,
      day: { pnl: 40, pct: 0.4, days: 1, fromDate: "2026-09-11", toDate: "2026-09-12" },
      week: windowTotal(week, "2026-09-12", 7),
      month: windowTotal(week, "2026-09-12", 30),
      split: { positions: 52, fxLegs: -5, fees: 7 },
      helped: [{ symbol: "VWRL.L", contribution: 60, pricePct: 0.8 }],
      hurt: [{ symbol: "NVDA", contribution: -20, pricePct: -0.9 }],
      persistence: assessPersistence({ rows: week, endDate: "2026-09-12", movers: [], regime: "risk on" }),
      reaction: {
        drawdownPct: 1.2,
        drawdownLimitPct: 15,
        dailyLossLimitPct: 5,
        haltActive: false,
        haltReason: null,
        cashPct: 32,
        targetPerNamePct: 15,
        dailyNotionalLimit: 2000,
        notes: ["Test note."],
      },
    });
    expect(summary).toMatch(/VWRL\.L/);
    expect(summary).toMatch(/NVDA/);
    expect(summary).toMatch(/below its best-ever value/);
    expect(summary).toMatch(/Test note\./);
  });
});
