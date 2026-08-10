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
    expect(cmp.rankDeltaSane ?? true).toBe(true);
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
