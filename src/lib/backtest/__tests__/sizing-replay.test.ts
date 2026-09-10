import { describe, it, expect } from "vitest";
import { runGovernorReplay, compareSizingArms, type ReplayBar } from "../governor-replay";

/** A rising tape: SMA20 crosses SMA50 and stays above, so buys are proposed. */
function risingBars(n: number, symbols: string[]): ReplayBar[] {
  const bars: ReplayBar[] = [];
  for (let i = 0; i < n; i += 1) {
    const date = new Date(Date.UTC(2023, 0, 2) + i * 86_400_000).toISOString().slice(0, 10);
    const closes: Record<string, number> = {};
    for (const s of symbols) {
      // Small dip early so the moving averages actually cross upward later.
      const drift = i < 60 ? 100 - i * 0.1 : 94 + (i - 60) * 0.25;
      closes[s] = drift;
    }
    bars.push({ date, closes });
  }
  return bars;
}

describe("sizing replay arm", () => {
  const bars = risingBars(320, ["VUSA.L", "AAPL"]);

  it("legacy sizing leaves sub-viable tickets untouched", () => {
    const out = runGovernorReplay(bars, "revised", {
      startingCash: 10_300,
      sizing: "legacy",
      viableFloorBase: 250,
      targetWeightPct: 0.01, // deliberately tiny tickets
      netEdgeGate: false,
    });
    expect(out.sizing).toBe("legacy");
    expect(out.buysSizedUp).toBe(0);
  });

  it("revised sizing raises tiny tickets to the fee-viable floor", () => {
    const out = runGovernorReplay(bars, "revised", {
      startingCash: 10_300,
      sizing: "revised",
      viableFloorBase: 250,
      targetWeightPct: 0.01,
      netEdgeGate: false,
    });
    expect(out.sizing).toBe("revised");
    expect(out.buysSizedUp).toBeGreaterThan(0);
    expect(out.buysBelowViableFloor).toBeLessThan(out.buysProposed + 1);
  });

  it("compares both arms and returns a verdict", () => {
    const cmp = compareSizingArms(bars, {
      startingCash: 10_300,
      viableFloorBase: 250,
      targetWeightPct: 0.02,
      netEdgeGate: false,
    });
    expect(cmp.legacy.sizing).toBe("legacy");
    expect(cmp.revised.sizing).toBe("revised");
    expect([
      "revised_sizing_better",
      "no_material_difference",
      "revised_sizing_worse",
    ]).toContain(cmp.verdict);
  });
});
