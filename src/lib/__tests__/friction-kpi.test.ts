import { describe, it, expect } from "vitest";
import {
  beforeAfterAttribution,
  chargedFriction,
  computeFrictionKpi,
  realisedCostOverlay,
  FRICTION_BUDGET_BPS,
  type FrictionFill,
} from "@/lib/friction-kpi";

function fill(over: Partial<FrictionFill> = {}): FrictionFill {
  const notional = over.notionalBase ?? 1000;
  return {
    symbol: "AAA.L",
    side: "buy",
    notionalBase: notional,
    feeReportedBase: 0,
    feeModelledBase: 10,
    commissionModelledBase: 3,
    spreadModelledBase: 5,
    taxModelledBase: 2,
    filledAt: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

describe("chargedFriction", () => {
  it("charges the broker's fee when it exceeds the model", () => {
    expect(chargedFriction(fill({ feeReportedBase: 25, feeModelledBase: 10 }))).toBe(25);
  });

  it("falls back to the model when the broker booked nothing", () => {
    expect(chargedFriction(fill({ feeReportedBase: 0, feeModelledBase: 10 }))).toBe(10);
  });

  it("treats a negative or non-finite fee as zero, never as a rebate", () => {
    expect(chargedFriction(fill({ feeReportedBase: -5, feeModelledBase: 4 }))).toBe(4);
    expect(chargedFriction(fill({ feeReportedBase: Number.NaN, feeModelledBase: 4 }))).toBe(4);
  });
});

describe("computeFrictionKpi", () => {
  it("expresses friction as bps of NAV and compares it to the budget", () => {
    const kpi = computeFrictionKpi({
      fills: [fill({ feeModelledBase: 10 }), fill({ feeModelledBase: 20 })],
      navBase: 10_000,
    });
    // 30 of 10,000 = 30bps, inside the 40bps line.
    expect(kpi.frictionBase).toBe(30);
    expect(kpi.frictionBps).toBeCloseTo(30, 6);
    expect(kpi.budgetBps).toBe(FRICTION_BUDGET_BPS);
    expect(kpi.headroomBps).toBeCloseTo(10, 6);
    expect(kpi.breach).toBe(false);
    expect(kpi.budgetUsed).toBeCloseTo(0.75, 6);
  });

  it("flags a breach once spend passes the budget line", () => {
    const kpi = computeFrictionKpi({
      fills: [fill({ feeModelledBase: 50 })],
      navBase: 10_000,
    });
    expect(kpi.frictionBps).toBeCloseTo(50, 6);
    expect(kpi.breach).toBe(true);
    expect(kpi.headroomBps).toBeCloseTo(-10, 6);
  });

  it("reports no bps at all rather than a fake zero when NAV is unknown", () => {
    const kpi = computeFrictionKpi({ fills: [fill()], navBase: 0 });
    expect(kpi.frictionBase).toBe(10);
    expect(kpi.frictionBps).toBeNull();
    expect(kpi.headroomBps).toBeNull();
    expect(kpi.breach).toBe(false);
    expect(kpi.annualisedDragPct).toBeNull();
  });

  it("splits the charge across components in the modelled proportions", () => {
    // Broker charged 20 against a modelled 10 (3 commission / 5 spread / 2 tax).
    const kpi = computeFrictionKpi({
      fills: [fill({ feeReportedBase: 20 })],
      navBase: 10_000,
    });
    expect(kpi.components.commissionBase).toBeCloseTo(6, 6);
    expect(kpi.components.spreadBase).toBeCloseTo(10, 6);
    expect(kpi.components.taxBase).toBeCloseTo(4, 6);
    const total =
      kpi.components.commissionBase + kpi.components.spreadBase + kpi.components.taxBase;
    expect(total).toBeCloseTo(kpi.frictionBase, 6);
  });

  it("books an unattributable charge rather than dropping it", () => {
    const kpi = computeFrictionKpi({
      fills: [
        fill({
          feeReportedBase: 7,
          feeModelledBase: 0,
          commissionModelledBase: 0,
          spreadModelledBase: 0,
          taxModelledBase: 0,
        }),
      ],
      navBase: 10_000,
    });
    expect(kpi.frictionBase).toBe(7);
    expect(kpi.components.commissionBase).toBe(7);
  });

  it("accumulates a chronological cumulative-bps series by day", () => {
    const kpi = computeFrictionKpi({
      fills: [
        fill({ filledAt: "2026-08-03T09:00:00.000Z", feeModelledBase: 10 }),
        fill({ filledAt: "2026-08-01T09:00:00.000Z", feeModelledBase: 10 }),
        fill({ filledAt: "2026-08-01T15:00:00.000Z", feeModelledBase: 10 }),
      ],
      navBase: 10_000,
    });
    expect(kpi.daily.map((d) => d.date)).toEqual(["2026-08-01", "2026-08-03"]);
    expect(kpi.daily[0]!.tickets).toBe(2);
    expect(kpi.daily[0]!.cumulativeBps).toBeCloseTo(20, 6);
    expect(kpi.daily[1]!.cumulativeBps).toBeCloseTo(30, 6);
  });

  it("reports turnover, average ticket and annualised drag", () => {
    const kpi = computeFrictionKpi({
      fills: [fill({ notionalBase: 1000 }), fill({ notionalBase: 3000 })],
      navBase: 10_000,
      windowDays: 30,
    });
    expect(kpi.turnoverBase).toBe(4000);
    expect(kpi.avgTicketBase).toBe(2000);
    expect(kpi.turnoverRatio).toBeCloseTo(0.4, 6);
    // 20bps per 30d ≈ 0.2% × (365/30) ≈ 2.43%/yr
    expect(kpi.annualisedDragPct).toBeCloseTo(2.433, 2);
  });

  it("ignores fills with no notional", () => {
    const kpi = computeFrictionKpi({
      fills: [fill({ notionalBase: 0, feeModelledBase: 99 }), fill()],
      navBase: 10_000,
    });
    expect(kpi.tickets).toBe(1);
    expect(kpi.frictionBase).toBe(10);
  });
});

describe("realisedCostOverlay", () => {
  it("scales the commission leg by what the broker actually charged", () => {
    const o = realisedCostOverlay({
      fills: [
        fill({ feeReportedBase: 10, commissionModelledBase: 4, taxModelledBase: 1, feeModelledBase: 10 }),
      ],
    });
    expect(o.degraded).toBe(false);
    expect(o.commissionMult).toBeCloseTo(2, 6);
    expect(o.extraBps).toBeCloseTo(0, 6);
  });

  it("carries cost the model cannot name as flat extra bps", () => {
    const o = realisedCostOverlay({
      fills: [
        fill({
          notionalBase: 10_000,
          feeReportedBase: 20,
          feeModelledBase: 10,
          commissionModelledBase: 8,
          taxModelledBase: 2,
        }),
      ],
    });
    // 10 unattributed on 10,000 notional = 10bps.
    expect(o.extraBps).toBeCloseTo(10, 6);
  });

  it("degrades to the modelled ladder when the broker booked nothing", () => {
    const o = realisedCostOverlay({ fills: [fill({ feeReportedBase: 0 })] });
    expect(o.degraded).toBe(true);
    expect(o.commissionMult).toBe(1);
    expect(o.extraBps).toBe(0);
    expect(o.note).toMatch(/no fees/i);
  });

  it("clamps an absurd ratio so the ladder stays interpretable", () => {
    const o = realisedCostOverlay({
      fills: [fill({ feeReportedBase: 5000, commissionModelledBase: 1, taxModelledBase: 0 })],
    });
    expect(o.commissionMult).toBe(4);
  });
});

describe("beforeAfterAttribution", () => {
  const cutover = "2026-08-11T00:00:00.000Z";

  function tape(count: number, startIso: string, fee: number, notional: number): FrictionFill[] {
    const t0 = Date.parse(startIso);
    return Array.from({ length: count }, (_, i) =>
      fill({
        filledAt: new Date(t0 + i * 86_400_000).toISOString(),
        feeModelledBase: fee,
        notionalBase: notional,
      }),
    );
  }

  it("splits the tape at the cutover and normalises unequal spans", () => {
    const a = beforeAfterAttribution({
      fills: [
        ...tape(10, "2026-08-01T10:00:00.000Z", 10, 500),
        ...tape(10, "2026-08-12T10:00:00.000Z", 2, 2000),
      ],
      cutoverIso: cutover,
      navBase: 10_000,
    });
    expect(a.before.tickets).toBe(10);
    expect(a.after.tickets).toBe(10);
    expect(a.after.avgTicketBase).toBeGreaterThan(a.before.avgTicketBase);
    expect(a.after.frictionBpsPer30d!).toBeLessThan(a.before.frictionBpsPer30d!);
    expect(a.deltas.frictionBpsPer30d!).toBeLessThan(0);
    expect(a.verdict).toBe("improved");
  });

  it("calls a cost increase worse", () => {
    const a = beforeAfterAttribution({
      fills: [
        ...tape(10, "2026-08-01T10:00:00.000Z", 2, 500),
        ...tape(10, "2026-08-12T10:00:00.000Z", 20, 500),
      ],
      cutoverIso: cutover,
      navBase: 10_000,
    });
    expect(a.verdict).toBe("worse");
    expect(a.deltas.frictionBpsPer30d!).toBeGreaterThan(0);
  });

  it("refuses a verdict when either side is too thin", () => {
    const a = beforeAfterAttribution({
      fills: [...tape(10, "2026-08-01T10:00:00.000Z", 10, 500), ...tape(2, "2026-08-12T10:00:00.000Z", 1, 500)],
      cutoverIso: cutover,
      navBase: 10_000,
    });
    expect(a.after.tickets).toBe(2);
    expect(a.verdict).toBe("insufficient_data");
  });

  it("reads window returns from equity marks inside each side", () => {
    const a = beforeAfterAttribution({
      fills: [
        ...tape(6, "2026-08-01T10:00:00.000Z", 5, 500),
        ...tape(6, "2026-08-12T10:00:00.000Z", 5, 500),
      ],
      cutoverIso: cutover,
      navBase: 10_000,
      equity: [
        { date: "2026-08-01", totalValue: 10_000 },
        { date: "2026-08-10", totalValue: 9_800 },
        { date: "2026-08-12", totalValue: 9_800 },
        { date: "2026-08-17", totalValue: 10_094 },
      ],
    });
    expect(a.before.returnPct).toBeCloseTo(-2, 6);
    expect(a.after.returnPct).toBeCloseTo(3, 6);
    expect(a.deltas.returnPct).toBeCloseTo(5, 6);
  });

  it("leaves returns null when a side has fewer than two marks", () => {
    const a = beforeAfterAttribution({
      fills: tape(6, "2026-08-01T10:00:00.000Z", 5, 500),
      cutoverIso: cutover,
      navBase: 10_000,
      equity: [{ date: "2026-08-01", totalValue: 10_000 }],
    });
    expect(a.before.returnPct).toBeNull();
    expect(a.after.returnPct).toBeNull();
    expect(a.deltas.returnPct).toBeNull();
  });
});
