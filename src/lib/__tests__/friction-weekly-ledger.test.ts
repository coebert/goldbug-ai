import { describe, it, expect } from "vitest";
import { weeklyFrictionLedger, ukWeekStart, type FrictionFill } from "../friction-kpi";

function fill(over: Partial<FrictionFill> & { filledAt: string }): FrictionFill {
  return {
    symbol: "MKS.L",
    side: "buy",
    notionalBase: 1000,
    feeReportedBase: 0,
    feeModelledBase: 10,
    commissionModelledBase: 6,
    spreadModelledBase: 3,
    taxModelledBase: 1,
    feeSource: "model",
    ...over,
  };
}

describe("ukWeekStart", () => {
  it("snaps to the Monday of the UK week", () => {
    expect(ukWeekStart("2026-08-12T09:00:00.000Z")).toBe("2026-08-10"); // Wed → Mon
    expect(ukWeekStart("2026-08-10T00:30:00.000Z")).toBe("2026-08-10");
    expect(ukWeekStart("2026-08-09T22:00:00.000Z")).toBe("2026-08-03"); // Sunday
  });

  it("uses the London clock, not UTC", () => {
    // 23:30Z on Sunday in BST is Monday 00:30 local → next week.
    expect(ukWeekStart("2026-08-09T23:30:00.000Z")).toBe("2026-08-10");
  });
});

describe("weeklyFrictionLedger", () => {
  it("buckets fills by week and splits the cost components", () => {
    const led = weeklyFrictionLedger({
      fills: [
        fill({ filledAt: "2026-08-10T10:00:00.000Z" }),
        fill({ filledAt: "2026-08-12T10:00:00.000Z", side: "sell", notionalBase: 2000 }),
        fill({ filledAt: "2026-08-04T10:00:00.000Z" }),
      ],
      navBase: 10_000,
    });

    expect(led.weeks.map((w) => w.weekStart)).toEqual(["2026-08-03", "2026-08-10"]);
    const cur = led.weeks[1]!;
    expect(cur.tickets).toBe(2);
    expect(cur.buyTickets).toBe(1);
    expect(cur.sellTickets).toBe(1);
    expect(cur.turnoverBase).toBe(3000);
    expect(cur.components.commissionBase).toBeCloseTo(12, 6);
    expect(cur.components.spreadBase).toBeCloseTo(6, 6);
    expect(cur.components.taxBase).toBeCloseTo(2, 6);
    expect(cur.chargedBase).toBeCloseTo(20, 6);
    expect(cur.chargedBpsOfTurnover).toBeCloseTo((20 / 3000) * 10_000, 6);
    expect(cur.chargedBpsOfNav).toBeCloseTo(20, 6);
    expect(cur.turnoverRatio).toBeCloseTo(0.3, 6);
    expect(cur.weekEnd).toBe("2026-08-16");
  });

  it("prefers the broker invoice split when present", () => {
    const led = weeklyFrictionLedger({
      fills: [
        fill({
          filledAt: "2026-08-11T10:00:00.000Z",
          feeReportedBase: 12,
          feeSource: "broker",
          reportedComponents: { commissionBase: 7, spreadBase: 0, taxBase: 5 },
        }),
      ],
      navBase: 10_000,
    });
    const w = led.weeks[0]!;
    expect(w.chargedBase).toBeCloseTo(12, 6);
    expect(w.components.commissionBase).toBeCloseTo(7, 6);
    expect(w.components.taxBase).toBeCloseTo(5, 6);
    expect(w.brokerCoverage).toBe(1);
  });

  it("uses the week's own NAV snapshot when available", () => {
    const led = weeklyFrictionLedger({
      fills: [fill({ filledAt: "2026-08-11T10:00:00.000Z" })],
      navBase: 10_000,
      navByDay: new Map([["2026-08-14", 5_000]]),
    });
    expect(led.weeks[0]!.navBase).toBe(5_000);
    expect(led.weeks[0]!.chargedBpsOfNav).toBeCloseTo(20, 6);
  });

  it("leaves NAV-relative columns null with no NAV at all", () => {
    const led = weeklyFrictionLedger({ fills: [fill({ filledAt: "2026-08-11T10:00:00.000Z" })] });
    expect(led.weeks[0]!.chargedBpsOfNav).toBeNull();
    expect(led.weeks[0]!.turnoverRatio).toBeNull();
  });

  it("totals across the returned weeks and keeps the weekly budget line", () => {
    const led = weeklyFrictionLedger({
      fills: [
        fill({ filledAt: "2026-08-04T10:00:00.000Z" }),
        fill({ filledAt: "2026-08-11T10:00:00.000Z" }),
      ],
      navBase: 10_000,
    });
    expect(led.totals.tickets).toBe(2);
    expect(led.totals.chargedBase).toBeCloseTo(20, 6);
    expect(led.weeklyBudgetBps).toBeCloseTo((40 * 7) / 30, 6);
  });

  it("keeps only the most recent weeks requested", () => {
    const fills = Array.from({ length: 6 }, (_, i) =>
      fill({ filledAt: `2026-0${7 + Math.floor(i / 4)}-${String(1 + (i % 4) * 7).padStart(2, "0")}T10:00:00.000Z` }),
    );
    const led = weeklyFrictionLedger({ fills, limitWeeks: 2, navBase: 10_000 });
    expect(led.weeks).toHaveLength(2);
  });

  it("ignores fills with no notional", () => {
    const led = weeklyFrictionLedger({
      fills: [fill({ filledAt: "2026-08-11T10:00:00.000Z", notionalBase: 0 })],
      navBase: 10_000,
    });
    expect(led.weeks).toHaveLength(0);
  });
});
