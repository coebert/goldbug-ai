import { describe, it, expect } from "vitest";
import {
  advFromBars,
  quoteExecutionImpact,
  realizedAtrPct,
  DEFAULT_EXECUTION_IMPACT,
} from "../execution-impact";
import { runBatchingArm, type OrderBatchingAbInput } from "../order-batching-ab";
import type { BacktestBar } from "../../backtest-runner";

function bars(n: number): BacktestBar[] {
  const out: BacktestBar[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
      closes: { AAA: 100 + Math.sin(i / 3) * 2 + i * 0.2 },
    });
  }
  return out;
}

describe("execution impact model", () => {
  it("derives a volatility proxy from closes", () => {
    expect(realizedAtrPct([100, 101, 100])).toBeCloseTo((0.01 + 1 / 101) / 2, 6);
    expect(realizedAtrPct([100])).toBe(0);
  });

  it("scales impact with the square root of participation", () => {
    const base = { symbol: "AAA", price: 100, history: [100, 101, 99, 102], assetClass: "stock" };
    const small = quoteExecutionImpact({ ...base, quantity: 10 });
    const big = quoteExecutionImpact({ ...base, quantity: 1000 });
    expect(big.impactBps).toBeGreaterThan(small.impactBps);
    // 100x notional → ~10x impact under the sqrt law.
    expect(big.impactBps / Math.max(small.impactBps, 1e-9)).toBeGreaterThan(5);
    expect(big.participation).toBeGreaterThan(small.participation);
    expect(big.slippageBase).toBeCloseTo((1000 * 100 * big.slippageBps) / 10_000, 6);
  });

  it("charges nothing when disabled", () => {
    const q = quoteExecutionImpact({
      symbol: "AAA",
      quantity: 1000,
      price: 100,
      config: { enabled: false },
    });
    expect(q.slippageBase).toBe(0);
    expect(q.slippageBps).toBe(0);
  });

  it("uses per-symbol ADV when supplied: thinner names cost more", () => {
    const thin = quoteExecutionImpact({
      symbol: "AAA",
      quantity: 500,
      price: 100,
      config: { advBySymbol: { AAA: 100_000 } },
    });
    const deep = quoteExecutionImpact({
      symbol: "AAA",
      quantity: 500,
      price: 100,
      config: { advBySymbol: { AAA: 50_000_000 } },
    });
    expect(thin.impactBps).toBeGreaterThan(deep.impactBps);
  });

  it("computes ADV from cached bars", () => {
    const adv = advFromBars([
      { symbol: "AAA", close: 10, volume: 100 },
      { symbol: "AAA", close: 10, volume: 300 },
      { symbol: "BBB", close: 5, volume: 0 },
    ]);
    expect(adv.AAA).toBe(2000);
    expect(adv.BBB).toBeUndefined();
    expect(DEFAULT_EXECUTION_IMPACT.enabled).toBe(true);
  });
});

describe("batching arm under market impact", () => {
  const series = bars(90);
  const input: OrderBatchingAbInput = {
    bars: series,
    signals: series.slice(60).map((b) => ({
      date: b.date,
      symbol: "AAA",
      side: "buy" as const,
      notionalBase: 400,
    })),
    startingCash: 20_000,
    minTicketBase: 1_200,
    windowHours: 96,
    execution: { advBySymbol: { AAA: 250_000 } },
  };

  it("charges impact on top of commission and reports participation", async () => {
    const withImpact = await runBatchingArm("batched", input);
    const without = await runBatchingArm("batched", {
      ...input,
      execution: { enabled: false },
    });

    expect(withImpact.totalSlippageBase).toBeGreaterThan(0);
    expect(without.totalSlippageBase).toBe(0);
    expect(withImpact.totalCostBase).toBeGreaterThan(without.totalCostBase);
    expect(withImpact.slippageBpsOfEquity).toBeGreaterThan(0);
    expect(withImpact.avgParticipation).toBeGreaterThan(0);
    for (const t of withImpact.trades) {
      expect(t.slippageBase).toBeGreaterThanOrEqual(0);
      expect(t.cost).toBeGreaterThanOrEqual(t.slippageBase);
    }
  });

  it("makes the batched arm's larger tickets pay more impact per ticket", async () => {
    const batched = await runBatchingArm("batched", input);
    const unbatched = await runBatchingArm("unbatched", input);
    const perTicket = (r: typeof batched) =>
      r.tickets > 0 ? r.totalSlippageBase / r.tickets : 0;
    if (batched.tickets > 0 && unbatched.tickets > 0) {
      expect(perTicket(batched)).toBeGreaterThanOrEqual(perTicket(unbatched) * 0.99);
    }
  });
});
