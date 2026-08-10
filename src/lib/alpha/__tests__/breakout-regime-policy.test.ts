import { describe, expect, it } from "vitest";
import {
  breakoutRegimeAction,
  breakoutRegimeBucket,
  expectancyTableFromStats,
  DEFAULT_BREAKOUT_EXPECTANCY,
  type BreakoutExpectancyTable,
} from "@/lib/alpha/breakout-regime-policy";
import { EMPTY_BREAKOUT, type BreakoutEvidence } from "@/lib/alpha/breakout";

function ev(over: Partial<BreakoutEvidence> = {}): BreakoutEvidence {
  return {
    ...EMPTY_BREAKOUT,
    state: "confirmed",
    direction: "up",
    level: 100,
    quality: 0.8,
    actionable: true,
    volume_ratio: 1.8,
    penetration_atr: 0.6,
    ...over,
  };
}

/** A table where the bull cell pays and sideways does not. */
const TABLE: BreakoutExpectancyTable = {
  source: "test",
  asOf: "2026-08-01",
  cells: {
    confirmed: {
      bull: { trades: 80, expectancyPct: 1.4, winRatePct: 56 },
      bear: { trades: 60, expectancyPct: -1.1, winRatePct: 41 },
      sideways: { trades: 70, expectancyPct: 0.9, winRatePct: 53 },
    },
  },
};

const calm = { vix: 14, realisedVol20d: 0.007 };

describe("breakoutRegimeBucket", () => {
  it("folds detector and matrix dialects onto three buckets", () => {
    for (const r of ["bull", "bull_quiet", "recovery", "risk_on", "trending"]) {
      expect(breakoutRegimeBucket(r)).toBe("bull");
    }
    for (const r of ["bear", "crisis", "correction", "risk_off"]) {
      expect(breakoutRegimeBucket(r)).toBe("bear");
    }
    expect(breakoutRegimeBucket("bull_volatile")).toBe("bull");
  });

  it("treats unknown or range-y labels as sideways (the cautious branch)", () => {
    for (const r of ["sideways", "range_bound", "chop", null, undefined, ""]) {
      expect(breakoutRegimeBucket(r)).toBe("sideways");
    }
  });
});

describe("breakoutRegimeAction — when the rule applies", () => {
  it("does not touch non-breakout trades", () => {
    const d = breakoutRegimeAction({ breakout: null, side: "buy", regime: "sideways", vol: calm });
    expect(d.applies).toBe(false);
    expect(d.action).toBe("trade");
    expect(d.mult).toBe(1);
  });

  it("never gates a sell, even in the worst regime", () => {
    const d = breakoutRegimeAction({
      breakout: ev(),
      side: "sell",
      regime: "crisis",
      vol: { vix: 45, realisedVol20d: 0.05 },
    });
    expect(d.applies).toBe(false);
    expect(d.action).not.toBe("skip");
    expect(d.mult).toBeGreaterThan(0);
  });

  it("ignores downside breaks on the buy side (the raw haircut already handles them)", () => {
    const d = breakoutRegimeAction({
      breakout: ev({ direction: "down" }),
      side: "buy",
      regime: "sideways",
      vol: calm,
      table: TABLE,
    });
    expect(d.applies).toBe(false);
    expect(d.mult).toBeLessThan(1); // still cut by the evidence multiplier
  });

  it("ignores states that are not tradeable cohorts", () => {
    for (const state of ["none", "extended"] as const) {
      const d = breakoutRegimeAction({ breakout: ev({ state }), side: "buy", regime: "bull", vol: calm });
      expect(d.applies).toBe(false);
    }
  });
});

describe("breakoutRegimeAction — expectancy gate", () => {
  it("lets a confirmed breakout run at full boost when the regime pays", () => {
    const d = breakoutRegimeAction({ breakout: ev(), side: "buy", regime: "bull_quiet", vol: calm, table: TABLE });
    expect(d.action).toBe("trade");
    expect(d.bucket).toBe("bull");
    expect(d.mult).toBe(d.rawMult);
    expect(d.mult).toBeGreaterThan(1);
    expect(d.note).toContain("+1.40%/trade");
  });

  it("skips when the regime's measured expectancy is negative on a real sample", () => {
    const d = breakoutRegimeAction({ breakout: ev(), side: "buy", regime: "bear", vol: calm, table: TABLE });
    expect(d.action).toBe("skip");
    expect(d.mult).toBe(0);
    expect(d.reason).toContain("no measured edge");
    expect(d.cell!.trades).toBe(60);
  });

  it("downsizes rather than skips when the sample is too thin to condemn", () => {
    const thin: BreakoutExpectancyTable = {
      source: "test",
      asOf: null,
      cells: { confirmed: { bull: { trades: 4, expectancyPct: -5, winRatePct: 10 } } },
    };
    const d = breakoutRegimeAction({ breakout: ev(), side: "buy", regime: "bull", vol: calm, table: thin });
    expect(d.action).toBe("downsize");
    expect(d.mult).toBeCloseTo(0.7, 8);
    expect(d.reason).toContain("unproven");
  });

  it("treats a missing cell as unproven, not as licence to size up", () => {
    const empty: BreakoutExpectancyTable = { source: "test", asOf: null, cells: {} };
    const d = breakoutRegimeAction({ breakout: ev(), side: "buy", regime: "bull", vol: calm, table: empty });
    expect(d.action).toBe("downsize");
    expect(d.cell).toBeNull();
    expect(d.mult).toBeLessThan(1);
  });

  it("respects a caller-supplied expectancy hurdle", () => {
    const d = breakoutRegimeAction({
      breakout: ev(),
      side: "buy",
      regime: "bull",
      vol: calm,
      table: TABLE,
      config: { minExpectancyPct: 2 }, // 1.4% no longer clears the bar
    });
    expect(d.action).toBe("skip");
  });
});

describe("breakoutRegimeAction — hostile tape", () => {
  it("downsizes in sideways tape even when the cell is positive", () => {
    const d = breakoutRegimeAction({ breakout: ev(), side: "buy", regime: "sideways", vol: calm, table: TABLE });
    expect(d.action).toBe("downsize");
    expect(d.mult).toBeCloseTo(0.5, 8);
    expect(d.rawMult).toBeGreaterThan(1); // the boost was stripped, not earned
    expect(d.note).toContain("sideways");
  });

  it("downsizes in a bull regime once volatility is elevated", () => {
    const byVix = breakoutRegimeAction({
      breakout: ev(),
      side: "buy",
      regime: "bull",
      vol: { vix: 27, realisedVol20d: 0.008 },
      table: TABLE,
    });
    const byRealised = breakoutRegimeAction({
      breakout: ev(),
      side: "buy",
      regime: "bull",
      vol: { vix: 15, realisedVol20d: 0.02 },
      table: TABLE,
    });
    for (const d of [byVix, byRealised]) {
      expect(d.highVol).toBe(true);
      expect(d.action).toBe("downsize");
      expect(d.mult).toBeCloseTo(0.5, 8);
    }
  });

  it("reads high vol off the regime label when the numbers are missing", () => {
    const d = breakoutRegimeAction({
      breakout: ev(),
      side: "buy",
      regime: "bull_volatile",
      vol: { vix: null, realisedVol20d: null },
      table: TABLE,
    });
    expect(d.highVol).toBe(true);
    expect(d.action).toBe("downsize");
  });

  it("skips entirely once VIX is at panic levels", () => {
    const d = breakoutRegimeAction({
      breakout: ev(),
      side: "buy",
      regime: "bull",
      vol: { vix: 35, realisedVol20d: 0.01 },
      table: TABLE,
    });
    expect(d.action).toBe("skip");
    expect(d.mult).toBe(0);
    expect(d.reason).toContain("VIX 35");
  });

  it("never sizes a hostile-tape trade above the calm-tape size", () => {
    const pending = ev({ state: "pending", actionable: false });
    const chop = breakoutRegimeAction({ breakout: pending, side: "buy", regime: "sideways", vol: calm, table: TABLE });
    expect(chop.mult).toBeLessThanOrEqual(chop.rawMult);
  });
});

describe("breakoutRegimeAction — recorded default evidence", () => {
  it("refuses confirmed breakout chases in every regime, per the Aug-2026 study", () => {
    for (const regime of ["bull_quiet", "bear", "sideways"]) {
      const d = breakoutRegimeAction({ breakout: ev(), side: "buy", regime, vol: calm });
      expect(d.applies).toBe(true);
      // Either vetoed on measured-negative expectancy, or cut for thin data.
      expect(d.action === "skip" || d.mult < 1).toBe(true);
      expect(d.mult).toBeLessThan(1.2);
    }
  });

  it("keeps the default table honest about its provenance", () => {
    expect(DEFAULT_BREAKOUT_EXPECTANCY.source).toMatch(/backtest/i);
    expect(DEFAULT_BREAKOUT_EXPECTANCY.cells.confirmed?.bull?.expectancyPct).toBeLessThan(0);
  });
});

describe("expectancyTableFromStats", () => {
  const rows = [
    { cohort: "confirmed", regime: "bull", trades: 50, expectancyPct: 1, winRatePct: 55 },
    { cohort: "confirmed", regime: "sideways", trades: 30, expectancyPct: -2, winRatePct: 40 },
    { cohort: "all", regime: "bull", trades: 999, expectancyPct: 9, winRatePct: 99 },
    { cohort: "confirmed", regime: "all", trades: 999, expectancyPct: 9, winRatePct: 99 },
  ];

  it("keeps only cohort x regime cells, dropping the aggregate rows", () => {
    const t = expectancyTableFromStats(rows, { source: "live" });
    expect(t.cells.confirmed?.bull?.expectancyPct).toBe(1);
    expect(t.cells.confirmed?.bull?.trades).toBe(50);
    expect(t.source).toBe("live");
  });

  it("pools trade-weighted when two source regimes map to one bucket", () => {
    const t = expectancyTableFromStats([
      { cohort: "confirmed", regime: "bear", trades: 10, expectancyPct: 3, winRatePct: 60 },
      { cohort: "confirmed", regime: "crisis", trades: 30, expectancyPct: -1, winRatePct: 40 },
    ]);
    const cell = t.cells.confirmed!.bear!;
    expect(cell.trades).toBe(40);
    expect(cell.expectancyPct).toBeCloseTo((3 * 10 + -1 * 30) / 40, 8);
    expect(cell.winRatePct).toBeCloseTo(45, 8);
  });

  it("feeds straight back into the gate", () => {
    const t = expectancyTableFromStats(rows, { source: "live" });
    expect(breakoutRegimeAction({ breakout: ev(), side: "buy", regime: "bull", vol: calm, table: t }).action).toBe("trade");
    expect(breakoutRegimeAction({ breakout: ev(), side: "buy", regime: "sideways", vol: calm, table: t }).action).toBe("skip");
  });
});
