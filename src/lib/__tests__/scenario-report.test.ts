import { describe, expect, it } from "vitest";
import {
  buildScenarioReport, computeCagrPct, defaultScenarioSpecs,
  drawdownFromCurve, runScenario, type DatedDecision,
} from "@/lib/scenario-report";
import type { SimState } from "@/lib/broker-simulator";

const initial: SimState = { cash: 100_000, holdings: [] };

function tradingCycle(): DatedDecision[] {
  // BUY -> hold -> SELL at a higher price.
  return [
    { id: "b1", date: "2024-01-02", symbol: "AAA", side: "BUY",
      quantity: 100, price: 100, availableVolume: 10_000 },
    { id: "s1", date: "2024-01-10", symbol: "AAA", side: "SELL",
      quantity: 100, price: 110, availableVolume: 10_000 },
  ];
}

describe("computeCagrPct", () => {
  it("returns null for < 2 points or non-positive start", () => {
    expect(computeCagrPct([])).toBeNull();
    expect(computeCagrPct([{ date: "2024-01-01", equity: 100 }])).toBeNull();
    expect(computeCagrPct([
      { date: "2024-01-01", equity: 0 },
      { date: "2024-06-01", equity: 100 },
    ])).toBeNull();
  });
  it("annualises correctly", () => {
    const oneYear = computeCagrPct([
      { date: "2024-01-01", equity: 100 },
      { date: "2025-01-01", equity: 110 },
    ])!;
    expect(oneYear).toBeGreaterThan(9.9);
    expect(oneYear).toBeLessThan(10.1);
  });
});

describe("drawdownFromCurve", () => {
  it("is always <= 0 and 0 at each new peak", () => {
    const dd = drawdownFromCurve([
      { date: "d1", equity: 100 },
      { date: "d2", equity: 120 },
      { date: "d3", equity: 90 },
      { date: "d4", equity: 130 },
    ]);
    expect(dd.map((d) => d.drawdown)).toEqual([0, 0, -25, 0]);
  });
});

describe("runScenario", () => {
  const specs = defaultScenarioSpecs();

  it("produces a monotonic-dated equity curve including opening equity", () => {
    const r = runScenario(specs[0], tradingCycle(), initial);
    expect(r.equityCurve.length).toBeGreaterThanOrEqual(2);
    expect(r.equityCurve[0].date).toBe("2024-01-02");
    expect(r.equityCurve[0].equity).toBe(100_000);
    for (let i = 1; i < r.equityCurve.length; i++) {
      expect(r.equityCurve[i].date >= r.equityCurve[i - 1].date).toBe(true);
    }
  });

  it("realistic frictions never produce higher ending equity than frictionless", () => {
    const [frictionless, , realistic] = specs; // by order
    const a = runScenario(frictionless, tradingCycle(), initial);
    const b = runScenario(realistic, tradingCycle(), initial);
    expect(b.summary.endEquity).toBeLessThanOrEqual(a.summary.endEquity + 1e-6);
  });

  it("summary invariants: fillRatio in [0,1], drawdown <= 0", () => {
    for (const s of specs) {
      const r = runScenario(s, tradingCycle(), initial);
      expect(r.summary.fillRatio).toBeGreaterThanOrEqual(0);
      expect(r.summary.fillRatio).toBeLessThanOrEqual(1);
      expect(r.summary.maxDrawdownPct).toBeLessThanOrEqual(0);
      expect(r.summary.trades).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("buildScenarioReport", () => {
  it("returns one report per scenario in supplied order", () => {
    const specs = defaultScenarioSpecs();
    const reports = buildScenarioReport({
      decisions: tradingCycle(), defaultInitial: initial, scenarios: specs,
    });
    expect(reports.map((r) => r.id)).toEqual(specs.map((s) => s.id));
  });
});
