import { describe, expect, it } from "vitest";
import {
  FRICTION_BUDGET_BPS,
  frictionTimeSeries,
  type FrictionFill,
} from "@/lib/friction-kpi";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function fill(day: string, fee: number, notional = 5_000): FrictionFill {
  return {
    symbol: "AAPL:xnas",
    side: "buy",
    notionalBase: notional,
    feeReportedBase: fee,
    feeModelledBase: fee,
    commissionModelledBase: fee,
    spreadModelledBase: 0,
    taxModelledBase: 0,
    filledAt: `${day}T10:00:00.000Z`,
  };
}

describe("frictionTimeSeries", () => {
  it("emits every calendar day in range, including days with no trades", () => {
    const s = frictionTimeSeries({ fills: [], navBase: 100_000, days: 30, now: NOW });
    expect(s).toHaveLength(30);
    expect(s[0]!.date).toBe("2026-07-13");
    expect(s[29]!.date).toBe("2026-08-11");
    expect(s.every((p) => p.frictionBps === 0)).toBe(true);
  });

  it("measures a trailing window, so a cost rolls off after 30 days", () => {
    const s = frictionTimeSeries({
      fills: [fill("2026-07-13", 400)],
      navBase: 100_000,
      days: 40,
      windowDays: 30,
      now: NOW,
    });
    const at = (d: string) => s.find((p) => p.date === d)!;
    // 400 on 100k = 40bps while inside the window...
    expect(at("2026-07-13").frictionBps).toBeCloseTo(40, 6);
    expect(at("2026-08-11").frictionBps).toBeCloseTo(40, 6);
    // ...and gone once the fill is 30 days behind. A cumulative series would
    // still be carrying it, and would read as permanently at budget.
    const rolled = frictionTimeSeries({
      fills: [fill("2026-07-01", 400)],
      navBase: 100_000,
      days: 40,
      windowDays: 30,
      now: NOW,
    });
    expect(rolled.find((p) => p.date === "2026-08-11")!.frictionBps).toBe(0);
  });

  it("flags days over the budget line rather than only the final day", () => {
    const s = frictionTimeSeries({
      fills: [fill("2026-08-01", 500)],
      navBase: 100_000,
      days: 30,
      now: NOW,
    });
    const breaches = s.filter((p) => p.breach);
    expect(breaches.length).toBeGreaterThan(1);
    expect(breaches[0]!.date).toBe("2026-08-01");
    expect(breaches[0]!.frictionBps!).toBeGreaterThan(FRICTION_BUDGET_BPS);
  });

  it("prices each day against that day's NAV and carries the last mark forward", () => {
    const s = frictionTimeSeries({
      fills: [fill("2026-08-10", 100)],
      navBase: 100_000,
      navByDay: { "2026-08-10": 50_000 },
      days: 5,
      now: NOW,
    });
    // 100 on the 50k snapshot = 20bps, and the 11th has no snapshot so it
    // inherits the 10th rather than snapping back to the fallback NAV.
    expect(s.find((p) => p.date === "2026-08-10")!.frictionBps).toBeCloseTo(20, 6);
    expect(s.find((p) => p.date === "2026-08-11")!.frictionBps).toBeCloseTo(20, 6);
  });

  it("reports no percentage when NAV is unknown instead of implying zero cost", () => {
    const s = frictionTimeSeries({
      fills: [fill("2026-08-10", 100)],
      navBase: 0,
      days: 3,
      now: NOW,
    });
    expect(s.every((p) => p.frictionBps === null)).toBe(true);
    expect(s.find((p) => p.date === "2026-08-10")!.frictionBase).toBeCloseTo(100, 6);
    expect(s.some((p) => p.breach)).toBe(false);
  });

  it("ignores fills dated after the chart's end", () => {
    const s = frictionTimeSeries({
      fills: [fill("2026-09-01", 900)],
      navBase: 100_000,
      days: 10,
      now: NOW,
    });
    expect(s.every((p) => p.frictionBase === 0)).toBe(true);
  });
});
