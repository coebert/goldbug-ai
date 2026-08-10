import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import {
  buildBreakoutDiagnostics,
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
    expect(buildBreakoutDiagnostics([])).toEqual({ symbols: [], states: [], notes: [] });
  });
});
