import { describe, it, expect } from "vitest";
import {
  describeDriver,
  rankTurnoverDrivers,
  reentryByLevel,
  reentryProfile,
  slope,
  turnoverAxisAttribution,
  turnoverCostCurve,
  type TradeLeg,
  type TurnoverRow,
} from "../turnover-attribution";

const row = (
  params: Record<string, number | boolean>,
  tradesPerYear: number,
  cagrPct = 0,
  feeDragPct = 0,
  flags?: { feasible?: boolean; disqualified?: boolean },
): TurnoverRow => ({
  params,
  metrics: { tradesPerYear, cagrPct, feeDragPct, maxDrawdownPct: 10 },
  check: {
    feasible: flags?.feasible ?? true,
    disqualified: flags?.disqualified ?? false,
  },
});

describe("slope", () => {
  it("recovers a known linear slope", () => {
    expect(slope([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(2, 10);
  });
  it("returns 0 without x spread or with <2 points", () => {
    expect(slope([3, 3, 3], [1, 2, 3])).toBe(0);
    expect(slope([1], [1])).toBe(0);
  });
});

describe("turnoverAxisAttribution", () => {
  const rows = [
    row({ reentry_min_days: 5 }, 120),
    row({ reentry_min_days: 5 }, 110),
    row({ reentry_min_days: 15 }, 70),
    row({ reentry_min_days: 15 }, 80),
    row({ reentry_min_days: 30 }, 30),
    row({ reentry_min_days: 30 }, 40),
  ];

  it("orders levels numerically and averages turnover", () => {
    const a = turnoverAxisAttribution(rows, "reentry_min_days");
    expect(a.levels.map((l) => l.value)).toEqual([5, 15, 30]);
    expect(a.levels[0]!.meanTradesPerYear).toBe(115);
    expect(a.levels[2]!.meanTradesPerYear).toBe(35);
  });

  it("identifies quietest/busiest levels and spread", () => {
    const a = turnoverAxisAttribution(rows, "reentry_min_days");
    expect(a.busiestValue).toBe(5);
    expect(a.quietestValue).toBe(30);
    expect(a.spreadPerYear).toBe(80);
  });

  it("reports a damping direction with a negative slope", () => {
    const a = turnoverAxisAttribution(rows, "reentry_min_days");
    expect(a.direction).toBe(-1);
    expect(a.slopePerUnit).toBeLessThan(0);
  });

  it("attributes nearly all variance to a dominant axis", () => {
    const a = turnoverAxisAttribution(rows, "reentry_min_days");
    expect(a.varianceShare).toBeGreaterThan(0.95);
    expect(a.varianceShare).toBeLessThanOrEqual(1);
  });

  it("gives a noise axis a low variance share", () => {
    const noisy = [
      row({ x: 1 }, 100),
      row({ x: 2 }, 30),
      row({ x: 1 }, 30),
      row({ x: 2 }, 100),
    ];
    expect(turnoverAxisAttribution(noisy, "x").varianceShare).toBeCloseTo(0, 6);
  });

  it("handles boolean levels", () => {
    const b = [
      row({ scale_out_enabled: false }, 40),
      row({ scale_out_enabled: true }, 90),
    ];
    const a = turnoverAxisAttribution(b, "scale_out_enabled");
    expect(a.levels.map((l) => l.value)).toEqual([false, true]);
    expect(a.busiestValue).toBe(true);
    expect(a.direction).toBe(1);
  });

  it("skips disqualified candidates", () => {
    const a = turnoverAxisAttribution(
      [...rows, row({ reentry_min_days: 5 }, 900, 0, 0, { disqualified: true })],
      "reentry_min_days",
    );
    expect(a.levels[0]!.n).toBe(2);
    expect(a.levels[0]!.meanTradesPerYear).toBe(115);
  });

  it("returns an empty attribution for a missing axis", () => {
    const a = turnoverAxisAttribution(rows, "nope");
    expect(a.levels).toEqual([]);
    expect(a.varianceShare).toBe(0);
    expect(a.quietestValue).toBeNull();
  });

  it("is flat when every candidate has identical turnover", () => {
    const flat = [row({ k: 1 }, 50), row({ k: 2 }, 50)];
    const a = turnoverAxisAttribution(flat, "k");
    expect(a.varianceShare).toBe(0);
    expect(a.spreadPerYear).toBe(0);
    expect(a.direction).toBe(0);
  });

  it("counts feasible candidates per level", () => {
    const a = turnoverAxisAttribution(
      [row({ k: 1 }, 10, 0, 0, { feasible: false }), row({ k: 1 }, 20)],
      "k",
    );
    expect(a.levels[0]!).toMatchObject({ n: 2, feasible: 1 });
  });
});

describe("rankTurnoverDrivers", () => {
  const rows = [
    row({ hold: 2, stop: 0.06 }, 130),
    row({ hold: 2, stop: 0.14 }, 120),
    row({ hold: 10, stop: 0.06 }, 45),
    row({ hold: 10, stop: 0.14 }, 40),
  ];

  it("ranks the dominant driver first", () => {
    const ranked = rankTurnoverDrivers(rows, ["stop", "hold"]);
    expect(ranked[0]!.key).toBe("hold");
    expect(ranked[0]!.varianceShare).toBeGreaterThan(ranked[1]!.varianceShare);
  });

  it("drops axes with no data", () => {
    expect(rankTurnoverDrivers(rows, ["missing"])).toEqual([]);
  });
});

describe("turnoverCostCurve", () => {
  it("measures negative CAGR slope when churn destroys value", () => {
    const c = turnoverCostCurve([
      row({}, 20, 8, 1),
      row({}, 60, 4, 3),
      row({}, 100, 0, 5),
    ]);
    expect(c.cagrPerTrade).toBeCloseTo(-0.1, 6);
    expect(c.feeDragPerTrade).toBeCloseTo(0.05, 6);
    expect(c.breakevenTradesPerYear).toBeCloseTo(100, 6);
    expect(c.bestObservedTradesPerYear).toBe(20);
    expect(c.n).toBe(3);
  });

  it("returns no breakeven when the fit is flat", () => {
    const c = turnoverCostCurve([row({}, 20, 5), row({}, 80, 5)]);
    expect(c.cagrPerTrade).toBeCloseTo(0, 10);
    expect(c.breakevenTradesPerYear).toBeNull();
  });

  it("ignores disqualified rows and degrades safely", () => {
    const c = turnoverCostCurve([row({}, 10, 1, 0, { disqualified: true })]);
    expect(c.n).toBe(0);
    expect(c.cagrPerTrade).toBe(0);
  });
});

describe("reentryProfile", () => {
  const legs: TradeLeg[] = [
    { date: "2026-01-01", side: "buy", symbol: "AAPL", quantity: 10 },
    { date: "2026-01-10", side: "sell", symbol: "AAPL", quantity: 10 },
    { date: "2026-01-13", side: "buy", symbol: "AAPL", quantity: 10 },
    { date: "2026-02-01", side: "sell", symbol: "AAPL", quantity: 10 },
    { date: "2026-03-01", side: "buy", symbol: "AAPL", quantity: 5 },
    { date: "2026-01-05", side: "buy", symbol: "MSFT", quantity: 4 },
    { date: "2026-01-20", side: "sell", symbol: "MSFT", quantity: 4 },
  ];

  it("pairs exits with the next re-entry per symbol", () => {
    const p = reentryProfile(legs);
    expect(p.events).toHaveLength(2);
    expect(p.events[0]).toMatchObject({
      symbol: "AAPL",
      exitDate: "2026-01-10",
      reentryDate: "2026-01-13",
      gapDays: 3,
    });
    expect(p.events[1]!.gapDays).toBe(28);
  });

  it("counts exits that never re-entered", () => {
    const p = reentryProfile(legs);
    expect(p.exitsWithoutReentry).toBe(1); // MSFT
    expect(p.reentryRate).toBeCloseTo(2 / 3, 6);
  });

  it("summarises gap statistics and fast re-entry share", () => {
    const p = reentryProfile(legs, { fastDays: 5 });
    expect(p.meanGapDays).toBeCloseTo(15.5, 6);
    expect(p.medianGapDays).toBeCloseTo(15.5, 6);
    expect(p.fastReentryShare).toBe(0.5);
    expect(p.fastDays).toBe(5);
  });

  it("counts round trips per symbol", () => {
    const p = reentryProfile(legs);
    expect(p.symbols).toBe(2);
    expect(p.roundTripsPerSymbol).toBeCloseTo(3 / 2, 6);
  });

  it("does not treat partial scale-outs as exits", () => {
    const p = reentryProfile([
      { date: "2026-01-01", side: "buy", symbol: "X", quantity: 10 },
      { date: "2026-01-05", side: "sell", symbol: "X", quantity: 4 },
      { date: "2026-01-08", side: "buy", symbol: "X", quantity: 4 },
    ]);
    expect(p.events).toHaveLength(0);
    expect(p.exitsWithoutReentry).toBe(0);
  });

  it("is order-insensitive (sorts by date)", () => {
    const shuffled = [...legs].reverse();
    expect(reentryProfile(shuffled).events).toEqual(reentryProfile(legs).events);
  });

  it("handles an empty log", () => {
    const p = reentryProfile([]);
    expect(p).toMatchObject({
      exitsWithoutReentry: 0,
      reentryRate: 0,
      meanGapDays: 0,
      medianGapDays: 0,
      fastReentryShare: 0,
      symbols: 0,
      roundTripsPerSymbol: 0,
    });
  });

  it("uses the median of an odd number of gaps", () => {
    const p = reentryProfile([
      { date: "2026-01-01", side: "buy", symbol: "A", quantity: 1 },
      { date: "2026-01-02", side: "sell", symbol: "A", quantity: 1 },
      { date: "2026-01-03", side: "buy", symbol: "A", quantity: 1 },
      { date: "2026-01-04", side: "sell", symbol: "A", quantity: 1 },
      { date: "2026-01-14", side: "buy", symbol: "A", quantity: 1 },
      { date: "2026-01-15", side: "sell", symbol: "A", quantity: 1 },
      { date: "2026-01-20", side: "buy", symbol: "A", quantity: 1 },
    ]);
    expect(p.events.map((e) => e.gapDays)).toEqual([1, 10, 5]);
    expect(p.medianGapDays).toBe(5);
  });
});

describe("reentryByLevel", () => {
  it("shows longer gaps at higher cooldown levels", () => {
    const fast: TradeLeg[] = [
      { date: "2026-01-01", side: "buy", symbol: "A", quantity: 1 },
      { date: "2026-01-05", side: "sell", symbol: "A", quantity: 1 },
      { date: "2026-01-07", side: "buy", symbol: "A", quantity: 1 },
    ];
    const slow: TradeLeg[] = [
      { date: "2026-01-01", side: "buy", symbol: "A", quantity: 1 },
      { date: "2026-01-05", side: "sell", symbol: "A", quantity: 1 },
      { date: "2026-02-05", side: "buy", symbol: "A", quantity: 1 },
    ];
    const rows = [
      row({ reentry_min_days: 5 }, 100),
      row({ reentry_min_days: 30 }, 20),
    ];
    const out = reentryByLevel(
      rows,
      "reentry_min_days",
      (r) => (r.params["reentry_min_days"] === 5 ? fast : slow),
      { fastDays: 5 },
    );
    expect(out.map((o) => o.value)).toEqual([5, 30]);
    expect(out[0]!.meanGapDays).toBe(2);
    expect(out[0]!.fastReentryShare).toBe(1);
    expect(out[1]!.meanGapDays).toBe(31);
    expect(out[1]!.fastReentryShare).toBe(0);
    expect(out[1]!.meanTradesPerYear).toBe(20);
  });

  it("tolerates levels with no re-entry events", () => {
    const out = reentryByLevel([row({ k: 1 }, 10)], "k", () => []);
    expect(out[0]).toMatchObject({ meanGapDays: 0, fastReentryShare: 0, reentryRate: 0 });
  });
});

describe("describeDriver", () => {
  it("describes a damping axis", () => {
    const a = turnoverAxisAttribution(
      [row({ hold: 2 }, 120), row({ hold: 10 }, 40)],
      "hold",
    );
    expect(describeDriver(a)).toContain("damps churn");
    expect(describeDriver(a)).toContain("quietest at 10");
  });

  it("flags single-level axes", () => {
    expect(describeDriver(turnoverAxisAttribution([row({ k: 1 }, 5)], "k"))).toContain(
      "single level",
    );
  });
});
