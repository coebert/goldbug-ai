import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import {
  applyDriverSizing,
  baselineExecution,
  buildExecutionGrid,
  driverSizingPlan,
  findExecutionCell,
} from "@/lib/breakout-driver-execution";

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

/** Winners on AAA, losers on BBB, plus a failed cohort as the control. */
function sample(): SignalTrade[] {
  const out: SignalTrade[] = [];
  for (let i = 0; i < 12; i++) out.push(trade({ symbol: "AAA", returnPct: 3 }));
  for (let i = 0; i < 12; i++) out.push(trade({ symbol: "BBB", returnPct: -3 }));
  for (let i = 0; i < 12; i++) out.push(trade({ symbol: "AAA", cohort: "failed", returnPct: -1 }));
  for (let i = 0; i < 12; i++) out.push(trade({ symbol: "BBB", cohort: "failed", returnPct: 1 }));
  return out;
}

describe("baselineExecution", () => {
  it("scores only the confirmed cohort at flat size 1", () => {
    const b = baselineExecution(sample());
    expect(b.signals).toBe(24);
    expect(b.taken).toBe(24);
    expect(b.avgSize).toBe(1);
    expect(b.deployedPct).toBe(100);
    expect(b.winRatePct).toBeCloseTo(50, 5);
  });
});

describe("applyDriverSizing", () => {
  it("sizes recommended symbols by their multiplier and skips avoided ones", () => {
    const trades = sample();
    const plan = driverSizingPlan(trades, { risk: "balanced", gapWeight: 2 });
    expect(plan.get("AAA")?.sizeMultiplier).toBeGreaterThan(0);
    expect(plan.get("BBB")?.action).toBe("avoid");

    const sized = applyDriverSizing(trades, { risk: "balanced", gapWeight: 2 });
    expect(sized.signals).toBe(24);
    expect(sized.taken).toBe(12);
    expect(sized.skipped).toBe(12);
    expect(sized.actionCounts.avoid).toBe(12);
    expect(sized.winRatePct).toBe(100);
  });

  it("beats the flat baseline when the losing name is dropped", () => {
    const trades = sample();
    const base = baselineExecution(trades);
    const sized = applyDriverSizing(trades, { risk: "balanced", gapWeight: 2 });
    expect(sized.cumulativeReturnPct).toBeGreaterThan(base.cumulativeReturnPct);
    expect(sized.maxDrawdownPct).toBeGreaterThanOrEqual(base.maxDrawdownPct);
    expect(sized.deployedPct).toBeLessThan(base.deployedPct);
  });

  it("deploys more capital as the risk setting loosens", () => {
    const trades = sample();
    const c = applyDriverSizing(trades, { risk: "conservative", gapWeight: 2 }).deployedPct;
    const b = applyDriverSizing(trades, { risk: "balanced", gapWeight: 2 }).deployedPct;
    const a = applyDriverSizing(trades, { risk: "aggressive", gapWeight: 2 }).deployedPct;
    expect(c).toBeLessThan(b);
    expect(b).toBeLessThan(a);
  });

  it("leaves unranked symbols at baseline size", () => {
    const trades = [...sample(), trade({ symbol: "CCC", returnPct: 1 })];
    const sized = applyDriverSizing(trades, {
      risk: "balanced",
      gapWeight: 2,
      unrankedSize: 1,
    });
    expect(sized.taken).toBe(13);
  });
});

describe("buildExecutionGrid", () => {
  it("returns a cell per risk × gap-weight combination with baseline deltas", () => {
    const grid = buildExecutionGrid(sample());
    expect(grid.cells).toHaveLength(grid.risks.length * grid.gapWeights.length);
    const cell = findExecutionCell(grid, "balanced", 2);
    expect(cell).not.toBeNull();
    expect(cell!.vsBaseline.cumulativeReturnPp).toBeCloseTo(
      cell!.cumulativeReturnPct - grid.baseline.cumulativeReturnPct,
      6,
    );
    expect(grid.best?.cumulativeReturnPct).toBeGreaterThanOrEqual(cell!.cumulativeReturnPct);
    expect(grid.summary).toContain("Baseline");
  });

  it("reports no signals when the confirmed cohort is empty", () => {
    const grid = buildExecutionGrid([trade({ cohort: "failed" })]);
    expect(grid.baseline.signals).toBe(0);
    expect(grid.summary).toBe("No confirmed signals to size.");
  });
});
