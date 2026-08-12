import { describe, it, expect } from "vitest";
import { runBuyAndHoldArm, runMomentumOnlyArm, runBenchmarkArms } from "../benchmark-arms";
import type { OrderBatchingAbInput } from "../order-batching-ab";
import type { BacktestBar } from "../../backtest-runner";

function bars(n: number): BacktestBar[] {
  const out: BacktestBar[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    out.push({ date: d, closes: { AAA: 100 + i * 0.5, BBB: 50 + i * 0.2 } });
  }
  return out;
}

const input: OrderBatchingAbInput = {
  bars: bars(80),
  signals: bars(80)
    .slice(60)
    .map((b) => ({ date: b.date, symbol: "AAA", side: "buy" as const, notionalBase: 300 })),
  startingCash: 10_000,
  minTicketBase: 500,
  costModel: (o) => 3 + o.quantity * o.price * 0.0005,
};

describe("benchmark arms", () => {
  it("buy & hold buys once per name on the first bar and holds", async () => {
    const r = await runBuyAndHoldArm(input);
    expect(r.id).toBe("buy_and_hold");
    expect(r.tickets).toBe(2);
    expect(r.trades.every((t) => t.date === input.bars[0].date)).toBe(true);
    expect(r.returnPct).toBeGreaterThan(0);
    expect(r.equityCurve.length).toBe(input.bars.length);
  });

  it("momentum-only routes every signal with no ticket floor", async () => {
    const mo = await runMomentumOnlyArm(input);
    expect(mo.id).toBe("momentum_only");
    expect(mo.signalsSkipped).toBe(0);
    expect(mo.tickets).toBe(input.signals.length);
  });

  it("scores the live arm against both baselines", async () => {
    const bench = await runBenchmarkArms(input, {
      returnPct: 12,
      maxDrawdownPct: 3,
      sharpe: 1.2,
      costBpsOfEquity: 20,
    });
    expect(bench.arms).toHaveLength(2);
    expect(bench.comparisons.map((c) => c.id).sort()).toEqual(["buy_and_hold", "momentum_only"]);
    for (const c of bench.comparisons) {
      expect(["beats", "lags", "matches"]).toContain(c.outcome);
      expect(Number.isFinite(c.returnDeltaPct)).toBe(true);
    }
    expect(bench.summary.length).toBeGreaterThan(10);
  });
});
