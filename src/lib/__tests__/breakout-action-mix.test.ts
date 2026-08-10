import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import { symbolDiagnostics } from "@/lib/breakout-diagnostics";
import { ACTION_STANCE, actionMixFor, diffActionMix } from "@/lib/breakout-action-mix";

let seq = 0;
const trade = (over: Partial<SignalTrade> = {}): SignalTrade => {
  seq += 1;
  return {
    symbol: "AAA",
    date: `2025-01-${String((seq % 28) + 1).padStart(2, "0")}`,
    cohort: "confirmed",
    direction: "up",
    side: "long",
    regime: "bull",
    realisedVol20d: 0.01,
    atrPct: 0.02,
    quality: 0.7,
    penetrationAtr: 0.5,
    volumeRatio: 1.4,
    falseBreakoutRate: 0.2,
    ageBars: 1,
    pendingLatencyBars: 1,
    entry: 100,
    exit: 102,
    exitReason: "target",
    barsHeld: 4,
    returnPct: 2,
    maxAdversePct: -1,
    maxFavourablePct: 3,
    ...over,
  };
};

function symbols() {
  const out: SignalTrade[] = [];
  for (let i = 0; i < 12; i++) out.push(trade({ symbol: "AAA", returnPct: 3 }));
  for (let i = 0; i < 12; i++) out.push(trade({ symbol: "BBB", returnPct: -3 }));
  for (let i = 0; i < 12; i++) out.push(trade({ symbol: "AAA", cohort: "failed", returnPct: -1 }));
  for (let i = 0; i < 12; i++) out.push(trade({ symbol: "BBB", cohort: "failed", returnPct: 4 }));
  return symbolDiagnostics(out, { minTrades: 1 });
}

describe("actionMixFor", () => {
  it("buckets every ranked driver exactly once per dimension", () => {
    const mix = actionMixFor(symbols(), { risk: "balanced", gapWeight: 2 });
    const sum = (r: Record<string, { count: number }>) =>
      Object.values(r).reduce((a, b) => a + b.count, 0);
    expect(mix.total).toBeGreaterThan(0);
    expect(sum(mix.byAction)).toBe(mix.total);
    expect(sum(mix.byStance)).toBe(mix.total);
    expect(sum(mix.byConfidence)).toBe(mix.total);
    expect(Math.round(Object.values(mix.byStance).reduce((a, b) => a + b.pct, 0))).toBe(100);
  });

  it("maps actions onto buy/hold/stand-aside stances", () => {
    expect(ACTION_STANCE.prioritise).toBe("buy");
    expect(ACTION_STANCE.trade).toBe("buy");
    expect(ACTION_STANCE.downsize).toBe("hold");
    expect(ACTION_STANCE.avoid).toBe("sell");
  });

  it("raises average size as risk appetite increases", () => {
    const c = actionMixFor(symbols(), { risk: "conservative", gapWeight: 2 });
    const a = actionMixFor(symbols(), { risk: "aggressive", gapWeight: 2 });
    expect(a.avgSize).toBeGreaterThan(c.avgSize);
  });
});

describe("diffActionMix", () => {
  it("reports the stance shift and average-size change between settings", () => {
    const from = actionMixFor(symbols(), { risk: "conservative", gapWeight: 0 });
    const to = actionMixFor(symbols(), { risk: "aggressive", gapWeight: 6 });
    const d = diffActionMix(from, to);
    expect(d.avgSizeDelta).toBeCloseTo(to.avgSize - from.avgSize, 10);
    const net = Object.values(d.byStance).reduce((a, b) => a + b.count, 0);
    expect(net).toBe(to.total - from.total);
    expect(d.summary.length).toBeGreaterThan(0);
  });

  it("is a no-op diff for identical settings", () => {
    const m = actionMixFor(symbols(), { risk: "balanced", gapWeight: 2 });
    const d = diffActionMix(m, m);
    expect(Object.values(d.byStance).every((v) => v.count === 0)).toBe(true);
    expect(d.avgSizeDelta).toBe(0);
    expect(d.summary).toContain("Same stance mix");
  });
});
