// Guard-integration tests for the broker-simulator wrapper used by
// the trading decision loop. Verifies:
//   1. risk_level → simulator-options mapping is stable
//   2. conservative REJECTS overspending BUYs; balanced TRUNCATES
//   3. sell-short attempts are rejected in conservative + balanced,
//      truncated in aggressive
//   4. clean, in-budget trades leave the ledger matching the engine
//   5. rejected engine trades and zero-qty rows are skipped correctly

import { describe, expect, it } from "vitest";
import {
  runBrokerSimulatorGuard,
  simulatorOptionsForRisk,
  decisionIdFor,
  type EngineExecutedTrade,
} from "../broker-simulator-integration";

const price = { AAA: 10, BBB: 20 };

function baseTrade(overrides: Partial<EngineExecutedTrade> = {}): EngineExecutedTrade {
  return {
    symbol: "AAA",
    side: "buy",
    quantity: 1,
    price: 10,
    value: 10,
    reason: "test",
    ...overrides,
  };
}

describe("broker-simulator integration — risk level mapping", () => {
  it("maps every risk level to a stable, distinct options shape", () => {
    expect(simulatorOptionsForRisk("conservative")).toEqual({
      truncateBuysToCash: false,
      truncateSellsToPosition: false,
    });
    expect(simulatorOptionsForRisk("balanced")).toEqual({
      truncateBuysToCash: true,
      truncateSellsToPosition: false,
    });
    expect(simulatorOptionsForRisk("aggressive")).toEqual({
      truncateBuysToCash: true,
      truncateSellsToPosition: true,
    });
  });
});

describe("broker-simulator integration — guard behavior", () => {
  it("in-budget trades ⇒ ledger matches engine, no rejections, no drift", () => {
    const result = runBrokerSimulatorGuard({
      riskLevel: "balanced",
      startingCash: 1000,
      startingHoldings: [],
      priceMap: price,
      executed: [
        baseTrade({ symbol: "AAA", side: "buy", quantity: 10, price: 10, value: 100 }),
        baseTrade({ symbol: "BBB", side: "buy", quantity: 5, price: 20, value: 100 }),
      ],
    });
    expect(result.rejectedTradeIds).toEqual([]);
    expect(result.drift).toEqual([]);
    expect(result.ledgerMatchesEngine).toBe(true);
    expect(result.simulation.finalState.cash).toBeCloseTo(800, 6);
  });

  it("conservative REJECTS a BUY that would overspend", () => {
    const trades = [
      baseTrade({ symbol: "AAA", side: "buy", quantity: 200, price: 10, value: 2000 }),
    ];
    const result = runBrokerSimulatorGuard({
      riskLevel: "conservative",
      startingCash: 500,
      startingHoldings: [],
      priceMap: price,
      executed: trades,
    });
    expect(result.rejectedTradeIds).toEqual([decisionIdFor(trades[0], 0)]);
    expect(result.ledgerMatchesEngine).toBe(false);
    // Nothing filled → cash preserved.
    expect(result.simulation.finalState.cash).toBe(500);
  });

  it("balanced TRUNCATES an over-cash BUY (reports drift, no rejection)", () => {
    const trades = [
      baseTrade({ symbol: "AAA", side: "buy", quantity: 200, price: 10, value: 2000 }),
    ];
    const result = runBrokerSimulatorGuard({
      riskLevel: "balanced",
      startingCash: 500,
      startingHoldings: [],
      priceMap: price,
      executed: trades,
    });
    expect(result.rejectedTradeIds).toEqual([]);
    expect(result.drift).toEqual([
      { symbol: "AAA", side: "buy", engineValue: 200, simulatedValue: 50 },
    ]);
    expect(result.ledgerMatchesEngine).toBe(false);
    expect(result.simulation.finalState.cash).toBeCloseTo(0, 6);
  });

  it("balanced REJECTS a SELL that would short (no truncation)", () => {
    const trades = [
      baseTrade({ symbol: "AAA", side: "sell", quantity: 5, price: 10, value: 50 }),
    ];
    const result = runBrokerSimulatorGuard({
      riskLevel: "balanced",
      startingCash: 100,
      startingHoldings: [], // no AAA held → any sell is a short
      priceMap: price,
      executed: trades,
    });
    expect(result.rejectedTradeIds).toEqual([decisionIdFor(trades[0], 0)]);
    expect(result.ledgerMatchesEngine).toBe(false);
  });

  it("aggressive TRUNCATES an oversized SELL to the held quantity", () => {
    const trades = [
      baseTrade({ symbol: "AAA", side: "sell", quantity: 100, price: 10, value: 1000 }),
    ];
    const result = runBrokerSimulatorGuard({
      riskLevel: "aggressive",
      startingCash: 0,
      startingHoldings: [{ symbol: "AAA", quantity: 3, avgCost: 8 }],
      priceMap: price,
      executed: trades,
    });
    expect(result.rejectedTradeIds).toEqual([]);
    expect(result.drift).toEqual([
      { symbol: "AAA", side: "sell", engineValue: 100, simulatedValue: 3 },
    ]);
    expect(result.simulation.finalState.holdings).toEqual([]);
    expect(result.simulation.finalState.cash).toBeCloseTo(30, 6);
  });

  it("skips engine-rejected rows and zero-quantity no-ops entirely", () => {
    const trades: EngineExecutedTrade[] = [
      baseTrade({ symbol: "AAA", side: "buy", quantity: 0, value: 0, rejected: "cap" }),
      baseTrade({ symbol: "AAA", side: "buy", quantity: 0, value: 0 }),
      baseTrade({ symbol: "AAA", side: "buy", quantity: 10, price: 10, value: 100 }),
    ];
    const result = runBrokerSimulatorGuard({
      riskLevel: "balanced",
      startingCash: 500,
      startingHoldings: [],
      priceMap: price,
      executed: trades,
    });
    // Only the third row reaches the simulator.
    expect(result.simulation.snapshots).toHaveLength(1);
    expect(result.simulation.snapshots[0].decisionId).toBe(decisionIdFor(trades[2], 2));
    expect(result.ledgerMatchesEngine).toBe(true);
  });

  it("respects per-trade fee when checking cash sufficiency", () => {
    const trades = [
      baseTrade({ symbol: "AAA", side: "buy", quantity: 10, price: 10, value: 100 }),
    ];
    const result = runBrokerSimulatorGuard({
      riskLevel: "conservative",
      startingCash: 100, // exactly enough WITHOUT fee
      startingHoldings: [],
      priceMap: price,
      executed: trades,
      feePerTrade: 5,
    });
    // Fee pushes us over → conservative rejects.
    expect(result.rejectedTradeIds).toHaveLength(1);
    expect(result.ledgerMatchesEngine).toBe(false);
  });
});
