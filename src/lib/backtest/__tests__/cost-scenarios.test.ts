import { describe, expect, it } from "vitest";
import {
  COST_SCENARIOS,
  monthlyOutcomes,
  rollingOutcomes,
  runCostScenarioSweep,
  scenarioTradeCost,
} from "../cost-scenarios";
import { generateReplaySignals } from "../batching-replay-signals";
import type { BacktestBar } from "../../backtest-runner";

function trendingBars(days: number, drift = 0.004): BacktestBar[] {
  const bars: BacktestBar[] = [];
  let a = 100;
  let b = 50;
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < days; i += 1) {
    // Deterministic wobble around a steady uptrend.
    const wobble = Math.sin(i / 5) * 0.01;
    a *= 1 + drift + wobble;
    b *= 1 + drift * 0.6 - wobble * 0.5;
    bars.push({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      closes: { "AAA.L": a, "BBB.L": b },
    });
  }
  return bars;
}

describe("scenarioTradeCost", () => {
  const order = {
    symbol: "MKS:xlon",
    side: "buy" as const,
    quantity: 100,
    price: 5,
    assetClass: "stock",
  };

  it("prices worst case above base above best", () => {
    const best = scenarioTradeCost(order, COST_SCENARIOS.best);
    const base = scenarioTradeCost(order, COST_SCENARIOS.base);
    const worst = scenarioTradeCost(order, COST_SCENARIOS.worst);
    expect(best).toBeLessThan(base);
    expect(base).toBeLessThan(worst);
  });

  it("drops UK stamp duty in the best case only", () => {
    // Same symbol, same spread — the only difference is the stamp multiplier.
    const withStamp = scenarioTradeCost(order, {
      ...COST_SCENARIOS.best,
      stampMult: 1,
    });
    const exempt = scenarioTradeCost(order, COST_SCENARIOS.best);
    const notional = order.quantity * order.price;
    expect(withStamp - exempt).toBeCloseTo(notional * 0.005, 6);
    // A US name is unaffected by the stamp multiplier either way.
    const us = { ...order, symbol: "AAPL:xnas" };
    expect(
      scenarioTradeCost(us, { ...COST_SCENARIOS.best, stampMult: 1 }),
    ).toBeCloseTo(scenarioTradeCost(us, COST_SCENARIOS.best), 6);
  });

  it("never returns a negative or non-finite cost", () => {
    const c = scenarioTradeCost({ ...order, quantity: 0, price: 0 }, COST_SCENARIOS.worst);
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBeGreaterThanOrEqual(0);
  });
});

describe("period outcomes", () => {
  const curve = [
    { date: "2024-01-02", totalValue: 100 },
    { date: "2024-01-31", totalValue: 110 },
    { date: "2024-02-01", totalValue: 110 },
    { date: "2024-02-28", totalValue: 99 },
    { date: "2024-03-01", totalValue: 99 },
    { date: "2024-03-29", totalValue: 120 },
  ];

  it("marks months up as loss-avoiding and months down as not", () => {
    const months = monthlyOutcomes(curve);
    expect(months.map((m) => m.period)).toEqual(["2024-01", "2024-02", "2024-03"]);
    expect(months.map((m) => m.avoidedLoss)).toEqual([true, false, true]);
  });

  it("rolls overlapping windows and skips incomplete ones", () => {
    const rolling = rollingOutcomes(curve, 2);
    expect(rolling).toHaveLength(curve.length - 2);
    expect(rolling[0]!.period).toBe("2024-02-01");
  });

  it("treats a flat period as a loss avoided", () => {
    const flat = monthlyOutcomes([
      { date: "2024-01-02", totalValue: 100 },
      { date: "2024-01-31", totalValue: 100 },
    ]);
    expect(flat[0]!.avoidedLoss).toBe(true);
  });
});

describe("runCostScenarioSweep", () => {
  const bars = trendingBars(300);
  const signals = generateReplaySignals(bars, {
    navBase: 10_000,
    addPctOfNav: 0.02,
    fastPeriod: 20,
    slowPeriod: 50,
    maxAddsPerName: 8,
  });
  const base = {
    bars,
    signals,
    startingCash: 10_000,
    minTicketBase: 250,
    windowHours: 96,
  };

  it("runs one arm per scenario and keeps the ordering", async () => {
    const r = await runCostScenarioSweep(base);
    expect(r.scenarios.map((s) => s.scenario.id)).toEqual(["best", "base", "worst"]);
    expect(r.bars).toBe(bars.length);
  });

  it("charges strictly more friction in the worst case than the best", async () => {
    const r = await runCostScenarioSweep(base);
    const best = r.scenarios.find((s) => s.scenario.id === "best")!;
    const worst = r.scenarios.find((s) => s.scenario.id === "worst")!;
    expect(worst.costBpsOfEquity).toBeGreaterThan(best.costBpsOfEquity);
    expect(r.frictionSpreadBps).toBeGreaterThan(0);
    // Higher friction can never improve the return of an identical signal set.
    expect(worst.returnPct).toBeLessThanOrEqual(best.returnPct + 1e-9);
    expect(r.costSensitivityPct).toBeGreaterThanOrEqual(0);
  });

  it("reports loss-avoidance frequencies as valid shares", async () => {
    const r = await runCostScenarioSweep(base);
    for (const s of r.scenarios) {
      expect(s.monthsProfitablePct).toBeGreaterThanOrEqual(0);
      expect(s.monthsProfitablePct).toBeLessThanOrEqual(1);
      expect(s.rollingProfitablePct).toBeGreaterThanOrEqual(0);
      expect(s.rollingProfitablePct).toBeLessThanOrEqual(1);
      expect(s.daysAboveStartPct).toBeLessThanOrEqual(1);
      expect(s.monthsTotal).toBe(s.months.length);
      expect(s.rollingWindows).toBeGreaterThan(0);
    }
  });

  it("calls an uptrend robust when it survives worst-case costs", async () => {
    const r = await runCostScenarioSweep(base);
    const worst = r.scenarios.find((s) => s.scenario.id === "worst")!;
    if (worst.profitable && worst.monthsProfitablePct >= 0.5) {
      expect(r.verdict).toBe("robust");
    } else {
      expect(["fragile", "unprofitable", "inconclusive"]).toContain(r.verdict);
    }
    expect(r.summary.length).toBeGreaterThan(20);
  });

  it("flags a downtrend as unprofitable even at best-case costs", async () => {
    const down = trendingBars(300, -0.004);
    const downSignals = generateReplaySignals(down, {
      navBase: 10_000,
      addPctOfNav: 0.02,
      fastPeriod: 20,
      slowPeriod: 50,
      maxAddsPerName: 8,
    });
    const r = await runCostScenarioSweep({ ...base, bars: down, signals: downSignals });
    expect(["unprofitable", "fragile", "inconclusive"]).toContain(r.verdict);
  });

  it("is inconclusive with no signals to trade", async () => {
    const r = await runCostScenarioSweep({ ...base, signals: [] });
    expect(r.verdict).toBe("inconclusive");
    expect(r.scenarios.every((s) => s.arm.tickets === 0)).toBe(true);
  });

  it("honours a restricted scenario list", async () => {
    const r = await runCostScenarioSweep({ ...base, scenarioIds: ["base"] });
    expect(r.scenarios).toHaveLength(1);
    expect(r.scenarios[0]!.scenario.id).toBe("base");
  });

  it("is deterministic across repeated runs", async () => {
    const [a, b] = await Promise.all([
      runCostScenarioSweep(base),
      runCostScenarioSweep(base),
    ]);
    expect(a.scenarios.map((s) => s.returnPct)).toEqual(b.scenarios.map((s) => s.returnPct));
    expect(a.verdict).toBe(b.verdict);
  });
});
