// Phase B — simulator integration tests for algoRegime guard.
import { describe, it, expect } from "vitest";
import { simulateBrokerExecution, type SimDecision } from "@/lib/broker-simulator";
import type { AlgoRegimeSnapshot } from "@/lib/microstructure/algo-regime";

const extreme: AlgoRegimeSnapshot = {
  volBurst: true, liquidityVacuum: true, whipsaw: true, correlationSpike: false, gapFade: false,
  score: 3, tier: "extreme", reason: "active: vol_burst, liquidity_vacuum, whipsaw",
  multipliers: { maxParticipation: 0.02, sizeScale: 0.4, tailHedgeBoostPctNav: 0.01, blockNewBuys: true },
};

const decisions: SimDecision[] = [
  { id: "b1", symbol: "AAA", side: "BUY", quantity: 10, price: 5 },
  { id: "s1", symbol: "BBB", side: "SELL", quantity: 3, price: 4 },
];

describe("simulateBrokerExecution + algoRegime", () => {
  const initial = { cash: 1000, holdings: [{ symbol: "BBB", quantity: 5, avgCost: 2 }] };

  it("passes through decisions when algoRegime is omitted", () => {
    const r = simulateBrokerExecution(initial, decisions);
    expect(r.snapshots).toHaveLength(2);
    expect(r.rejections).toHaveLength(0);
  });

  it("rejects BUYs with algo_regime_block and executes SELLs when blockNewBuys is true", () => {
    const r = simulateBrokerExecution(initial, decisions, { algoRegime: extreme });
    const buyRej = r.rejections.find((x) => x.reason === "algo_regime_block");
    expect(buyRej).toBeDefined();
    expect(buyRej?.decisionId).toBe("b1");
    // SELL still executes.
    expect(r.snapshots.some((s) => s.decisionId === "s1" && s.side === "SELL")).toBe(true);
    // The BUY produced no snapshot (no cash spent).
    expect(r.snapshots.find((s) => s.decisionId === "b1")).toBeUndefined();
    expect(r.finalState.cash).toBeGreaterThanOrEqual(1000);
  });

  it("tightens maxParticipationRate to the regime cap when stricter than caller's", () => {
    const bigBuy: SimDecision[] = [{ id: "big", symbol: "AAA", side: "BUY", quantity: 1000, price: 1, availableVolume: 1000 }];
    const softRegime: AlgoRegimeSnapshot = {
      ...extreme, tier: "elevated", score: 1,
      multipliers: { ...extreme.multipliers, blockNewBuys: false, maxParticipation: 0.05 },
    };
    // Caller wants 50% participation; regime wants 5%. Effective cap is 5%.
    const r = simulateBrokerExecution(
      { cash: 10_000, holdings: [] },
      bigBuy,
      { liquidity: { maxParticipationRate: 0.5 }, algoRegime: softRegime },
    );
    const s = r.snapshots[0];
    expect(s).toBeDefined();
    expect(s.fillQuantity).toBe(50); // 5% of 1000
    expect(s.truncationReason).toBe("liquidity");
  });
});
