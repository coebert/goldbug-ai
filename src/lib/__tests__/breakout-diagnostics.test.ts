import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import {
  buildBreakoutDiagnostics,
  regimeGateVerdict,
  regimeVolContext,
  symbolDiagnostics,
  topDrivers,
  qualityBucket,
  signalStateDiagnostics,
  summarizeSlice,
  symbolDiagnostics,
} from "@/lib/breakout-diagnostics";

function trade(over: Partial<SignalTrade>): SignalTrade {
  return {
    symbol: "AAA",
    date: "2025-01-02",
    cohort: "confirmed",
    direction: "up",
    side: "long",
    regime: "bull",
    realisedVol20d: 0.01,
    atrPct: 0.02,
    quality: 0.8,
    penetrationAtr: 0.5,
    volumeRatio: 1.4,
    falseBreakoutRate: 0.2,
    ageBars: 2,
    pendingLatencyBars: null,
    entry: 100,
    exit: 103,
    exitReason: "target",
    barsHeld: 4,
    returnPct: 3,
    maxAdversePct: -1,
    maxFavourablePct: 3,
    ...over,
  };
}

describe("summarizeSlice", () => {
  it("returns zeros for an empty slice", () => {
    expect(summarizeSlice([])).toMatchObject({ trades: 0, winRatePct: 0, sumReturnPct: 0 });
  });

  it("computes win rate, mean, median and totals", () => {
    const s = summarizeSlice([
      trade({ returnPct: 4, barsHeld: 2 }),
      trade({ returnPct: -2, barsHeld: 4 }),
      trade({ returnPct: 1, barsHeld: 6 }),
    ]);
    expect(s.trades).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.winRatePct).toBeCloseTo(66.667, 2);
    expect(s.avgReturnPct).toBeCloseTo(1, 10);
    expect(s.medianReturnPct).toBe(1);
    expect(s.sumReturnPct).toBe(3);
    expect(s.bestPct).toBe(4);
    expect(s.worstPct).toBe(-2);
    expect(s.avgBarsHeld).toBe(4);
  });
});

describe("symbolDiagnostics", () => {
  const trades: SignalTrade[] = [
    trade({ symbol: "WIN", returnPct: 8 }),
    trade({ symbol: "WIN", returnPct: 6 }),
    trade({ symbol: "WIN", cohort: "failed", returnPct: -1 }),
    trade({ symbol: "LOSE", returnPct: -7 }),
    trade({ symbol: "LOSE", returnPct: -3 }),
    trade({ symbol: "LOSE", cohort: "failed", returnPct: 2 }),
  ];

  it("splits each symbol into confirmed and failed slices", () => {
    const rows = symbolDiagnostics(trades);
    const win = rows.find((r) => r.symbol === "WIN")!;
    expect(win.confirmed.trades).toBe(2);
    expect(win.failed.trades).toBe(1);
    expect(win.confirmed.avgReturnPct).toBe(7);
    expect(win.avgReturnGapPct).toBe(8);
    expect(win.winRateGapPp).toBe(100);
  });

  it("attributes signed P&L share and labels drivers vs drags", () => {
    const rows = symbolDiagnostics(trades);
    const win = rows.find((r) => r.symbol === "WIN")!;
    const lose = rows.find((r) => r.symbol === "LOSE")!;
    // gross confirmed movement = 8 + 6 + 7 + 3 = 24
    expect(win.confirmedContributionPct).toBeCloseTo((14 / 24) * 100, 6);
    expect(lose.confirmedContributionPct).toBeCloseTo((-10 / 24) * 100, 6);
    expect(win.role).toBe("driver");
    expect(lose.role).toBe("drag");
    // Highest absolute contribution first.
    expect(rows[0]!.symbol).toBe("WIN");
  });

  it("marks thin samples rather than judging them, and honours the limit", () => {
    const rows = symbolDiagnostics([...trades, trade({ symbol: "THIN", returnPct: 0.1 })]);
    expect(rows.find((r) => r.symbol === "THIN")!.role).toBe("thin");
    expect(symbolDiagnostics(trades, { limit: 1 })).toHaveLength(1);
  });
});

describe("signalStateDiagnostics", () => {
  const trades: SignalTrade[] = [
    trade({ cohort: "confirmed", direction: "up", exitReason: "target", quality: 0.9, returnPct: 5 }),
    trade({ cohort: "confirmed", direction: "down", side: "short", exitReason: "stop", quality: 0.3, returnPct: -4, maxAdversePct: -4 }),
    trade({ cohort: "failed", direction: "up", side: "short", exitReason: "horizon", quality: 0.5, returnPct: 1 }),
  ];

  it("buckets quality by threshold", () => {
    expect(qualityBucket(0.39)).toBe("low");
    expect(qualityBucket(0.4)).toBe("medium");
    expect(qualityBucket(0.7)).toBe("high");
  });

  it("splits each cohort by direction, exit reason and quality", () => {
    const states = signalStateDiagnostics(trades);
    expect(states.map((s) => s.cohort)).toEqual(["confirmed", "failed"]);
    const confirmed = states[0]!;
    expect(confirmed.overall.trades).toBe(2);
    expect(confirmed.byDirection.map((d) => d.direction)).toEqual(["up", "down"]);
    expect(confirmed.byExitReason.map((e) => e.reason).sort()).toEqual(["stop", "target"]);
    expect(confirmed.byQuality.map((q) => q.bucket)).toEqual(["low", "high"]);
    expect(confirmed.stopRatePct).toBe(50);
    expect(confirmed.targetRatePct).toBe(50);
    expect(confirmed.avgMaxAdversePct).toBeCloseTo(-2.5, 10);
  });

  it("omits empty splits", () => {
    const states = signalStateDiagnostics([trades[2]!]);
    expect(states[0]!.byDirection).toHaveLength(1);
    expect(states[0]!.byQuality).toHaveLength(1);
  });
});

describe("buildBreakoutDiagnostics", () => {
  it("produces symbol rows, state blocks and plain-language notes", () => {
    const trades: SignalTrade[] = [
      ...Array.from({ length: 6 }, (_, i) =>
        trade({ symbol: "WIN", returnPct: 4 + i, date: `2025-01-0${i + 1}` }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        trade({ symbol: "LOSE", returnPct: -3 - i, exitReason: "stop", date: `2025-02-0${i + 1}` }),
      ),
      trade({ symbol: "WIN", cohort: "failed", returnPct: -1 }),
    ];
    const d = buildBreakoutDiagnostics(trades);
    expect(d.symbols.length).toBe(2);
    expect(d.states.some((s) => s.cohort === "confirmed")).toBe(true);
    expect(d.notes.join(" ")).toContain("WIN");
    expect(d.notes.join(" ")).toContain("LOSE");
    expect(d.notes.some((n) => n.includes("stop out"))).toBe(true);
  });

  it("is empty-safe", () => {
    const d = buildBreakoutDiagnostics([]);
    expect(d.symbols).toEqual([]);
    expect(d.states).toEqual([]);
    expect(d.notes).toEqual([]);
    expect(d.regimeVol.cells).toEqual([]);
  });
});

describe("regime + vol context", () => {
  it("splits a group into regime cells with vol measurements", () => {
    const trades = [
      ...Array.from({ length: 4 }, (_, i) =>
        trade({ regime: "bull", realisedVol20d: 0.008, returnPct: 2, date: `2025-01-0${i + 1}` }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        trade({ regime: "sideways", realisedVol20d: 0.02, returnPct: -2, date: `2025-02-0${i + 1}` }),
      ),
    ];
    const ctx = regimeVolContext(trades);
    expect(ctx.cells.map((c) => c.regime)).toEqual(["bull", "sideways"]);
    const bull = ctx.cells.find((c) => c.regime === "bull")!;
    const side = ctx.cells.find((c) => c.regime === "sideways")!;
    expect(bull.sharePct).toBeCloseTo(40);
    expect(bull.highVolSharePct).toBe(0);
    expect(side.highVolSharePct).toBe(100);
    expect(side.avgRealisedVol20d).toBeCloseTo(0.02);
    expect(ctx.sidewaysSharePct).toBeCloseTo(60);
    expect(ctx.highVolSharePct).toBeCloseTo(60);
  });

  it("ignores missing vol readings rather than counting them as calm", () => {
    const ctx = regimeVolContext([
      trade({ realisedVol20d: null }),
      trade({ realisedVol20d: 0.02, date: "2025-01-03" }),
    ]);
    expect(ctx.avgRealisedVol20d).toBeCloseTo(0.02);
    expect(ctx.highVolSharePct).toBeCloseTo(50);
  });

  it("vetoes a proven-negative cell (regime gating)", () => {
    const v = regimeGateVerdict({
      regime: "bull",
      highVol: false,
      trades: 60,
      expectancyPct: -0.8,
    });
    expect(v.action).toBe("skip");
    expect(v.mult).toBe(0);
    expect(v.driver).toBe("regime gating");
  });

  it("caps size in sideways tape and attributes it to chop", () => {
    const v = regimeGateVerdict({ regime: "sideways", highVol: false, trades: 60, expectancyPct: 1.2 });
    expect(v.action).toBe("downsize");
    expect(v.driver).toBe("sideways tape");
    expect(v.mult).toBeLessThan(1);
  });

  it("attributes a high-vol cap separately from chop", () => {
    const v = regimeGateVerdict({ regime: "bull", highVol: true, trades: 60, expectancyPct: 1.2 });
    expect(v.action).toBe("downsize");
    expect(v.driver).toBe("high-vol downsize");
  });

  it("flags a thin cell as unproven rather than bad", () => {
    const v = regimeGateVerdict({ regime: "bull", highVol: false, trades: 3, expectancyPct: -0.5 });
    expect(v.action).toBe("downsize");
    expect(v.driver).toBe("unproven sample");
  });

  it("passes a proven-positive benign cell at full size", () => {
    const v = regimeGateVerdict({ regime: "bull", highVol: false, trades: 60, expectancyPct: 1.4 });
    expect(v.action).toBe("trade");
    expect(v.mult).toBe(1);
    expect(v.driver).toBe("none");
  });

  it("attaches regime cells to symbol rows and state blocks", () => {
    const trades = [
      ...Array.from({ length: 30 }, (_, i) =>
        trade({
          symbol: "AAA",
          regime: i % 2 ? "sideways" : "bull",
          realisedVol20d: i % 2 ? 0.03 : 0.007,
          returnPct: i % 2 ? -2 : 1,
          date: `2025-03-${String(i + 1).padStart(2, "0")}`,
        }),
      ),
    ];
    const d = buildBreakoutDiagnostics(trades);
    expect(d.symbols[0]!.regimeVol.cells.length).toBe(2);
    expect(d.symbols[0]!.confirmedRegimeVol.cells.length).toBe(2);
    const confirmed = d.states.find((s) => s.cohort === "confirmed")!;
    expect(confirmed.regimeVol.cells.map((c) => c.regime)).toEqual(["bull", "sideways"]);
    // The sideways cell is both chop and high-vol: the high-vol layer binds.
    const side = confirmed.regimeVol.cells.find((c) => c.regime === "sideways")!;
    expect(side.gate.action).toBe("downsize");
    expect(side.gate.driver).toBe("high-vol downsize");
    expect(side.highVolSharePct).toBe(100);
    expect(d.notes[0]).toContain("Gate context");
  });
});


describe("top drivers", () => {
  const many = (n: number, over: Partial<Parameters<typeof trade>[0]>, from = 1) =>
    Array.from({ length: n }, (_, i) =>
      trade({ ...over, date: `2025-04-${String(from + i).padStart(2, "0")}` }),
    );

  it("ranks positive and negative contributors on opposite sides", () => {
    const trades = [
      ...many(8, { symbol: "GOOD", returnPct: 5 }),
      ...many(8, { symbol: "BAD", returnPct: -5 }, 10),
    ];
    const d = buildBreakoutDiagnostics(trades);
    expect(d.topDrivers.positive[0]!.symbol).toBe("GOOD");
    expect(d.topDrivers.negative[0]!.symbol).toBe("BAD");
    expect(d.topDrivers.positive[0]!.score).toBeGreaterThan(0);
    expect(d.topDrivers.negative[0]!.score).toBeLessThan(0);
  });

  it("surfaces a small-share name when its expectancy gap is large", () => {
    const symbols = symbolDiagnostics([
      ...many(30, { symbol: "BIG", returnPct: 1 }),
      ...many(4, { symbol: "EDGE", returnPct: 6 }, 1),
      ...many(4, { symbol: "EDGE", cohort: "failed", returnPct: -8 }, 6),
    ]);
    const ranked = topDrivers(symbols);
    const edge = ranked.positive.find((r) => r.symbol === "EDGE")!;
    expect(edge.lead).toBe("expectancy gap");
    expect(edge.expectancyGapPct).toBeGreaterThan(10);
  });

  it("ignores names below the confirmed-signal floor", () => {
    const ranked = topDrivers(symbolDiagnostics(many(2, { symbol: "THIN", returnPct: 9 })), {
      minConfirmed: 3,
    });
    expect(ranked.positive).toEqual([]);
    expect(ranked.negative).toEqual([]);
    expect(ranked.summary).toContain("Not enough");
  });

  it("respects the per-side limit and gap weight", () => {
    const symbols = symbolDiagnostics([
      ...many(4, { symbol: "A", returnPct: 4 }),
      ...many(4, { symbol: "B", returnPct: 3 }, 6),
      ...many(4, { symbol: "C", returnPct: 2 }, 11),
    ]);
    const ranked = topDrivers(symbols, { limit: 2, gapWeight: 0 });
    expect(ranked.positive.map((r) => r.symbol)).toEqual(["A", "B"]);
    expect(ranked.gapWeight).toBe(0);
    expect(ranked.positive.every((r) => r.lead === "P&L share")).toBe(true);
  });

  it("is empty-safe", () => {
    expect(topDrivers([])).toMatchObject({ positive: [], negative: [] });
    expect(buildBreakoutDiagnostics([]).topDrivers.positive).toEqual([]);
  });
});
