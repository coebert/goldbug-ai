import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import { symbolDiagnostics } from "@/lib/breakout-diagnostics";
import { compareDriverSettings } from "@/lib/breakout-driver-compare";

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

describe("compareDriverSettings", () => {
  it("returns a row per symbol seen on either side", () => {
    const cmp = compareDriverSettings(
      symbols(),
      { risk: "balanced", gapWeight: 0 },
      { risk: "balanced", gapWeight: 4 },
    );
    expect(cmp.rows.map((r) => r.symbol).sort()).toEqual(["AAA", "BBB"]);
  });

  it("flags identical settings as a no-op diff", () => {
    const cmp = compareDriverSettings(
      symbols(),
      { risk: "balanced", gapWeight: 2 },
      { risk: "balanced", gapWeight: 2 },
    );
    expect(cmp.changedCount).toBe(0);
    expect(cmp.rows.every((r) => r.status === "same")).toBe(true);
    expect(cmp.rows.every((r) => r.rankDelta === 0)).toBe(true);
    expect(cmp.summary).toContain("same setting");
  });

  it("surfaces size changes when the risk level moves", () => {
    const cmp = compareDriverSettings(
      symbols(),
      { risk: "conservative", gapWeight: 2 },
      { risk: "aggressive", gapWeight: 2 },
    );
    const changed = cmp.rows.filter((r) => (r.sizeDelta ?? 0) !== 0 || r.actionChanged);
    expect(changed.length).toBeGreaterThan(0);
    for (const r of cmp.rows) {
      if (r.a.sizeMultiplier != null && r.b.sizeMultiplier != null) {
        expect(r.b.sizeMultiplier).toBeGreaterThanOrEqual(r.a.sizeMultiplier);
      }
    }
  });

  it("respects the row limit and keeps movers first", () => {
    const cmp = compareDriverSettings(
      symbols(),
      { risk: "conservative", gapWeight: 0 },
      { risk: "aggressive", gapWeight: 6 },
      { limit: 1 },
    );
    expect(cmp.rows).toHaveLength(1);
  });
});

describe("explainDriverChange", () => {
  it("attributes the whole score delta to the gap-weight term", () => {
    const cmp = compareDriverSettings(
      symbols(),
      { risk: "balanced", gapWeight: 1 },
      { risk: "balanced", gapWeight: 4 },
    );
    for (const r of cmp.rows) {
      if (r.scoreDelta == null) continue;
      const summed = r.explain.scoreFactors.reduce((a, f) => a + f.delta, 0);
      expect(summed).toBeCloseTo(r.scoreDelta, 6);
      const share = r.explain.scoreFactors.find((f) => f.label === "P&L share");
      expect(share?.delta).toBe(0);
      const gap = r.explain.scoreFactors.find((f) => f.label === "Expectancy gap × weight");
      expect(gap?.delta).toBeCloseTo((4 - 1) * (r.b.expectancyGapPct ?? 0), 6);
    }
  });

  it("names the risk change as the cause when only the risk level moves", () => {
    const cmp = compareDriverSettings(
      symbols(),
      { risk: "conservative", gapWeight: 2 },
      { risk: "aggressive", gapWeight: 2 },
    );
    for (const r of cmp.rows) {
      expect(r.scoreDelta).toBe(0);
      expect(r.explain.headline).toContain("risk conservative → aggressive");
      expect(r.explain.sizeReason).toBeTruthy();
    }
  });

  it("reports confidence factors worst-first with the sample and breadth inputs", () => {
    const cmp = compareDriverSettings(
      symbols(),
      { risk: "balanced", gapWeight: 1 },
      { risk: "balanced", gapWeight: 3 },
    );
    const row = cmp.rows[0]!;
    const labels = row.explain.confidenceFactors.map((f) => f.label);
    expect(labels).toContain("Sample");
    expect(labels).toContain("Breadth");
    const values = row.explain.confidenceFactors.map((f) => f.value);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });

  it("explains entering and leaving the ranked set", () => {
    const cmp = compareDriverSettings(
      symbols(),
      { risk: "balanced", gapWeight: 2 },
      { risk: "balanced", gapWeight: 2 },
      { minConfirmed: 1 },
    );
    for (const r of cmp.rows) {
      expect(r.explain.rankReason).toBeTruthy();
    }
  });
});
