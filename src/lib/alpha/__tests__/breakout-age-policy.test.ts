import { describe, expect, it } from "vitest";
import { EMPTY_BREAKOUT, type BreakoutEvidence } from "@/lib/alpha/breakout";
import {
  ageBandFor,
  agePolicyFromRecommendation,
  breakoutAgeAction,
  breakoutMinHoldBars,
  DEFAULT_BREAKOUT_AGE_POLICY,
} from "@/lib/alpha/breakout-age-policy";
import { breakoutRegimeAction } from "@/lib/alpha/breakout-regime-policy";

function evidence(over: Partial<BreakoutEvidence>): BreakoutEvidence {
  return {
    ...EMPTY_BREAKOUT,
    state: "confirmed",
    direction: "up",
    level: 100,
    quality: 0.8,
    actionable: true,
    bars_since_breakout: 2,
    reasons: [],
    ...over,
  };
}

describe("breakoutAgeAction", () => {
  it("passes through sells, non-breakouts and downside evidence", () => {
    expect(breakoutAgeAction({ breakout: evidence({}), side: "sell" }).applies).toBe(false);
    expect(breakoutAgeAction({ breakout: null, side: "buy" }).mult).toBe(1);
    expect(
      breakoutAgeAction({ breakout: evidence({ direction: "down" }), side: "buy" }).applies,
    ).toBe(false);
    expect(
      breakoutAgeAction({ breakout: evidence({ state: "none", direction: "up" }), side: "buy" })
        .applies,
    ).toBe(false);
  });

  it("keeps a fresh break at full size", () => {
    const d = breakoutAgeAction({
      breakout: evidence({ state: "pending", bars_since_breakout: 1 }),
      side: "buy",
    });
    expect(d.applies).toBe(true);
    expect(d.veto).toBe(false);
    expect(d.mult).toBe(1);
  });

  it("trims a just-confirmed break and vetoes a late chase", () => {
    expect(breakoutAgeAction({ breakout: evidence({ bars_since_breakout: 3 }), side: "buy" }).mult)
      .toBeCloseTo(0.85, 6);
    const late = breakoutAgeAction({ breakout: evidence({ bars_since_breakout: 5 }), side: "buy" });
    expect(late.veto).toBe(true);
    expect(late.mult).toBe(0);
    expect(late.reason).toContain("not chased");
  });

  it("vetoes stale/extended breaks at any age past the last band", () => {
    const d = breakoutAgeAction({
      breakout: evidence({ state: "extended", bars_since_breakout: 40 }),
      side: "buy",
    });
    expect(d.veto).toBe(true);
    expect(d.band?.label).toBe("stale");
  });

  it("exposes contiguous, exhaustive bands and a hold-time floor", () => {
    for (let age = 0; age <= 30; age++) expect(ageBandFor(age)).not.toBeNull();
    expect(breakoutMinHoldBars()).toBe(DEFAULT_BREAKOUT_AGE_POLICY.minHoldBars);
    expect(breakoutMinHoldBars()).toBeGreaterThanOrEqual(3);
  });

  it("can be rebuilt from a measured recommendation", () => {
    const p = agePolicyFromRecommendation(
      [
        { minAgeBars: 0, maxAgeBars: 2, mult: 1.1, veto: false, trades: 90, expectancyPct: 0.7 },
        { minAgeBars: 3, maxAgeBars: Infinity, mult: 0.5, veto: true, trades: 40, expectancyPct: -0.9 },
      ],
      { source: "test study" },
    );
    expect(breakoutAgeAction({ breakout: evidence({ bars_since_breakout: 1 }), side: "buy", policy: p }).mult).toBe(1.1);
    const old = breakoutAgeAction({ breakout: evidence({ bars_since_breakout: 9 }), side: "buy", policy: p });
    expect(old.veto).toBe(true);
    expect(old.mult).toBe(0);
  });
});

describe("breakoutRegimeAction with the age layer", () => {
  const positiveTable = {
    source: "test",
    asOf: null,
    cells: {
      confirmed: { bull: { trades: 200, expectancyPct: 1.5, winRatePct: 58 } },
      pending: { bull: { trades: 200, expectancyPct: 1.5, winRatePct: 58 } },
    },
  };

  it("skips a late chase even when the regime cell is measured positive", () => {
    const d = breakoutRegimeAction({
      breakout: evidence({ bars_since_breakout: 6 }),
      side: "buy",
      regime: "bull",
      table: positiveTable,
    });
    expect(d.action).toBe("skip");
    expect(d.mult).toBe(0);
    expect(d.age.veto).toBe(true);
  });

  it("applies the freshness haircut to an otherwise full-size trade", () => {
    const fresh = breakoutRegimeAction({
      breakout: evidence({ state: "pending", bars_since_breakout: 1 }),
      side: "buy",
      regime: "bull",
      table: positiveTable,
    });
    const aged = breakoutRegimeAction({
      breakout: evidence({ bars_since_breakout: 3 }),
      side: "buy",
      regime: "bull",
      table: positiveTable,
    });
    expect(fresh.action).toBe("trade");
    expect(aged.mult).toBeLessThan(fresh.rawMult);
    expect(aged.mult).toBeCloseTo(aged.rawMult * 0.85, 6);
    expect(aged.action).toBe("downsize");
  });

  it("never gates sells", () => {
    const d = breakoutRegimeAction({
      breakout: evidence({ bars_since_breakout: 12 }),
      side: "sell",
      regime: "sideways",
    });
    expect(d.action).toBe("trade");
    expect(d.age.applies).toBe(false);
  });
});
