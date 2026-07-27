import { describe, expect, it } from "vitest";
import {
  simulateBrokerExecution,
  buildExecutionQualityReport,
  type SimDecision,
  type SimState,
} from "../broker-simulator";

const state = (cash = 1_000_000): SimState => ({ cash, holdings: [] });

describe("broker-simulator execution-quality snapshot fields", () => {
  it("frictionless BUY reports zero slippage and mirrors expected price", () => {
    const res = simulateBrokerExecution(state(), [
      { id: "d1", symbol: "AAA", side: "BUY", quantity: 10, price: 100 },
    ]);
    const s = res.snapshots[0];
    expect(s.expectedPrice).toBe(100);
    expect(s.slippageBps).toBe(0);
    expect(s.participationRate).toBeNull();
    expect(s.liquidityAdjustedSlippageBps).toBeNull();
  });

  it("friction-model BUY reports adverse slippage in bps", () => {
    // slippageBps=50 => fill = 100 * 1.005 = 100.5 => (0.5/100)*1e4 = 50 bps
    const res = simulateBrokerExecution(state(), [
      { id: "d1", symbol: "AAA", side: "BUY", quantity: 10, price: 100 },
    ], { frictions: { slippageBps: 50 } });
    const s = res.snapshots[0];
    expect(s.expectedPrice).toBe(100);
    expect(s.fillPrice).toBeCloseTo(100.5, 10);
    expect(s.slippageBps).toBeCloseTo(50, 8);
  });

  it("friction-model SELL slippage is positive when trader receives less", () => {
    const setup = simulateBrokerExecution(state(), [
      { id: "buy", symbol: "AAA", side: "BUY", quantity: 10, price: 100 },
    ]);
    const res = simulateBrokerExecution(setup.finalState, [
      { id: "sell", symbol: "AAA", side: "SELL", quantity: 10, price: 100 },
    ], { frictions: { slippageBps: 30 } });
    const s = res.snapshots[0];
    expect(s.fillPrice).toBeCloseTo(99.7, 10);
    expect(s.slippageBps).toBeCloseTo(30, 8);
  });

  it("participation + liquidity-adjusted slippage populated when a book is defined", () => {
    // rawVolume=1000, cap*rate = 500 => fill capped at 500 → participation = 0.5
    const res = simulateBrokerExecution(state(), [
      { id: "d1", symbol: "AAA", side: "BUY", quantity: 5000, price: 100 },
    ], {
      liquidity: { availableVolume: { AAA: 1000 }, maxParticipationRate: 0.5 },
      frictions: { slippageBps: 40 },
    });
    const s = res.snapshots[0];
    expect(s.fillQuantity).toBe(500);
    expect(s.participationRate).toBeCloseTo(0.5, 10);
    expect(s.slippageBps).toBeCloseTo(40, 8);
    expect(s.liquidityAdjustedSlippageBps).toBeCloseTo(80, 8);
  });
});

describe("broker-simulator executionQuality aggregate report", () => {
  it("computes fill ratio, counts, and rejection breakdown", () => {
    const decisions: SimDecision[] = [
      { id: "d1", symbol: "AAA", side: "BUY", quantity: 100, price: 10 },
      // Second decision will fully fill from cash.
      { id: "d2", symbol: "BBB", side: "BUY", quantity: 50, price: 10 },
      // Rejected — no position to sell.
      { id: "d3", symbol: "CCC", side: "SELL", quantity: 1, price: 10 },
    ];
    const res = simulateBrokerExecution(state(2_000), decisions, {
      liquidity: { availableVolume: { AAA: 40 } }, // partial fill 40/100
    });
    const q = res.executionQuality;
    expect(q.decisionCount).toBe(3);
    expect(q.totalRequested).toBe(150);
    expect(q.totalFilled).toBe(90); // 40 + 50
    expect(q.fillRatio).toBeCloseTo(90 / 150, 10);
    expect(q.fullyFilledCount).toBe(1); // BBB
    expect(q.partialFillCount).toBe(1); // AAA
    expect(q.rejectionCount).toBe(1);
    expect(q.rejectionsByReason.no_position_to_sell).toBe(1);
    expect(q.bySymbol.AAA.fillRatio).toBeCloseTo(0.4, 10);
    expect(q.bySymbol.BBB.fillRatio).toBe(1);
  });

  it("weighted avg slippage is notional-weighted across snapshots", () => {
    // Two fills same symbol; big one at 10 bps, small at 100 bps.
    // Weights: 1000*100=100_000 and 10*100=1_000 → weighted avg ≈ 10.89 bps
    const decisions: SimDecision[] = [
      { id: "big", symbol: "AAA", side: "BUY", quantity: 1000, price: 100 },
      { id: "small", symbol: "AAA", side: "BUY", quantity: 10, price: 100 },
    ];
    const res = simulateBrokerExecution(state(1_000_000), decisions, {
      frictions: { slippageBps: 10 },
    });
    // Manually rewrite the small snapshot slippage to 100bps for assertion clarity.
    const rewired = [...res.snapshots];
    rewired[1] = { ...rewired[1], slippageBps: 100 };
    const q = buildExecutionQualityReport(2, rewired, res.rejections);
    const expected = (1000 * 100 * 10 + 10 * 100 * 100) / (1000 * 100 + 10 * 100);
    expect(q.weightedAvgSlippageBps).toBeCloseTo(expected, 8);
  });

  it("liquidity-adjusted slippage only counts constrained fills", () => {
    const decisions: SimDecision[] = [
      // Constrained: participation 0.5, slippage 40bps → adj 80bps
      { id: "c", symbol: "AAA", side: "BUY", quantity: 5000, price: 100 },
      // Unconstrained: no book defined
      { id: "u", symbol: "BBB", side: "BUY", quantity: 10, price: 100 },
    ];
    const res = simulateBrokerExecution(state(1_000_000), decisions, {
      liquidity: {
        availableVolume: { AAA: 1000 },
        maxParticipationRate: 0.5,
      },
      frictions: { slippageBps: 40 },
    });
    const q = res.executionQuality;
    expect(q.weightedAvgLiquidityAdjustedSlippageBps).toBeCloseTo(80, 8);
    expect(q.avgParticipationRate).toBeCloseTo(0.5, 10);
    // Only the AAA (constrained) snapshot contributed the adj number.
    expect(q.bySymbol.AAA.avgParticipationRate).toBeCloseTo(0.5, 10);
    expect(q.bySymbol.BBB.avgParticipationRate).toBeNull();
    expect(q.bySymbol.BBB.weightedAvgLiquidityAdjustedSlippageBps).toBeNull();
  });

  it("time-sliced residuals are counted as fills, not extra requests", () => {
    const res = simulateBrokerExecution(state(1_000_000), [
      { id: "d1", symbol: "AAA", side: "BUY", quantity: 1000, price: 100 },
    ], {
      liquidity: { availableVolume: { AAA: 300 } },
      timeSliceUnfilled: true,
      timeSliceMaxAttempts: 5,
    });
    const q = res.executionQuality;
    expect(res.snapshots.length).toBe(4); // 300+300+300+100
    expect(q.totalRequested).toBe(1000); // parent snapshot only
    expect(q.totalFilled).toBe(1000);
    expect(q.fillRatio).toBe(1);
  });

  it("empty run returns a neutral report (fillRatio=1, no NaNs)", () => {
    const res = simulateBrokerExecution(state(), []);
    const q = res.executionQuality;
    expect(q.decisionCount).toBe(0);
    expect(q.totalRequested).toBe(0);
    expect(q.totalFilled).toBe(0);
    expect(q.fillRatio).toBe(1);
    expect(q.weightedAvgSlippageBps).toBe(0);
    expect(q.weightedAvgLiquidityAdjustedSlippageBps).toBeNull();
    expect(q.avgParticipationRate).toBeNull();
    expect(q.bySymbol).toEqual({});
  });
});
