// Enforces the broker-simulator invariants: no borrowing, no leverage,
// and cash + holdings snapshots stay internally consistent after
// every decision step.

import { describe, expect, it } from "vitest";
import {
  simulateBrokerExecution,
  type SimDecision,
  type SimState,
  type SimSnapshot,
} from "../broker-simulator";

const empty: SimState = { cash: 1000, holdings: [] };

function assertConsistent(snap: SimSnapshot, markPrices?: Record<string, number>) {
  const recomputed = snap.holdings.reduce((s, h) => {
    const mark = markPrices?.[h.symbol];
    const price = Number.isFinite(mark) ? Number(mark) : h.avgCost;
    const safe = Number.isFinite(price) && price > 0 ? price : 0;
    return s + h.quantity * safe;
  }, 0);
  expect(snap.holdingsValue).toBeCloseTo(recomputed, 10);
  expect(snap.totalValue).toBeCloseTo(snap.cash + snap.holdingsValue, 10);
  expect(snap.cash).toBeGreaterThanOrEqual(0);
  for (const h of snap.holdings) {
    expect(h.quantity).toBeGreaterThan(0);
    expect(h.avgCost).toBeGreaterThanOrEqual(0);
  }
}

describe("simulateBrokerExecution — invariants", () => {
  it("no-op run returns the initial state and empty snapshots", () => {
    const r = simulateBrokerExecution(empty, []);
    expect(r.finalState).toEqual(empty);
    expect(r.snapshots).toEqual([]);
    expect(r.rejections).toEqual([]);
  });

  it("single BUY debits cash, adds holding, and emits a consistent snapshot", () => {
    const r = simulateBrokerExecution(empty, [
      { id: "d1", symbol: "AAPL", side: "BUY", quantity: 5, price: 100 },
    ]);
    expect(r.finalState.cash).toBe(500);
    expect(r.finalState.holdings).toEqual([{ symbol: "AAPL", quantity: 5, avgCost: 100 }]);
    expect(r.snapshots).toHaveLength(1);
    const [s] = r.snapshots;
    expect(s.step).toBe(1);
    expect(s.decisionId).toBe("d1");
    expect(s.fillQuantity).toBe(5);
    assertConsistent(s);
  });

  it("BUY with fee subtracts fee AND price*qty (no borrowing)", () => {
    const r = simulateBrokerExecution({ cash: 100, holdings: [] }, [
      { id: "d1", symbol: "X", side: "BUY", quantity: 1, price: 90, fee: 5 },
    ]);
    expect(r.finalState.cash).toBe(5); // 100 - 90 - 5
    assertConsistent(r.snapshots[0]);
  });

  it("NO BORROWING: BUY that exceeds cash is truncated to affordable qty by default", () => {
    const r = simulateBrokerExecution({ cash: 250, holdings: [] }, [
      { id: "d1", symbol: "X", side: "BUY", quantity: 10, price: 100 },
    ]);
    // 250 / 100 = 2.5 units affordable, no fee.
    expect(r.finalState.holdings[0].quantity).toBe(2.5);
    expect(r.finalState.cash).toBe(0);
    expect(r.rejections).toEqual([]);
    assertConsistent(r.snapshots[0]);
  });

  it("NO BORROWING: with truncateBuysToCash=false, oversized BUY is rejected as would_borrow", () => {
    const r = simulateBrokerExecution({ cash: 250, holdings: [] }, [
      { id: "d1", symbol: "X", side: "BUY", quantity: 10, price: 100 },
    ], { truncateBuysToCash: false });
    expect(r.snapshots).toHaveLength(0);
    expect(r.rejections).toEqual([
      expect.objectContaining({ reason: "would_borrow", decisionId: "d1" }),
    ]);
    expect(r.finalState).toEqual({ cash: 250, holdings: [] });
  });

  it("fee alone exceeds cash → rejected as insufficient_cash (never dips below 0)", () => {
    const r = simulateBrokerExecution({ cash: 3, holdings: [] }, [
      { id: "d1", symbol: "X", side: "BUY", quantity: 1, price: 1, fee: 5 },
    ]);
    expect(r.rejections[0].reason).toBe("insufficient_cash");
    expect(r.finalState.cash).toBe(3);
  });

  it("NO LEVERAGE: SELL beyond held quantity is truncated to held", () => {
    const start: SimState = { cash: 0, holdings: [{ symbol: "X", quantity: 3, avgCost: 10 }] };
    const r = simulateBrokerExecution(start, [
      { id: "d1", symbol: "X", side: "SELL", quantity: 100, price: 12 },
    ]);
    expect(r.finalState.cash).toBe(36); // 3 * 12
    expect(r.finalState.holdings).toEqual([]);
    expect(r.rejections).toEqual([]);
    expect(r.snapshots[0].fillQuantity).toBe(3);
    assertConsistent(r.snapshots[0]);
  });

  it("NO LEVERAGE: with truncateSellsToPosition=false, oversized SELL is rejected as would_short", () => {
    const start: SimState = { cash: 0, holdings: [{ symbol: "X", quantity: 3, avgCost: 10 }] };
    const r = simulateBrokerExecution(start, [
      { id: "d1", symbol: "X", side: "SELL", quantity: 100, price: 12 },
    ], { truncateSellsToPosition: false });
    expect(r.rejections[0].reason).toBe("would_short");
    expect(r.finalState).toEqual(start);
  });

  it("SELL with no position is rejected (no shorting)", () => {
    const r = simulateBrokerExecution(empty, [
      { id: "d1", symbol: "X", side: "SELL", quantity: 1, price: 12 },
    ]);
    expect(r.rejections[0].reason).toBe("no_position_to_sell");
    expect(r.finalState).toEqual(empty);
  });

  it("weighted-average cost updates on additional BUYs", () => {
    const r = simulateBrokerExecution({ cash: 1000, holdings: [] }, [
      { id: "d1", symbol: "X", side: "BUY", quantity: 2, price: 100 }, // avg 100
      { id: "d2", symbol: "X", side: "BUY", quantity: 2, price: 200 }, // avg (200+400)/4 = 150
    ]);
    const h = r.finalState.holdings[0];
    expect(h.quantity).toBe(4);
    expect(h.avgCost).toBe(150);
    for (const s of r.snapshots) assertConsistent(s);
  });

  it("realized PnL reported on SELL uses avgCost and includes fee", () => {
    const r = simulateBrokerExecution({ cash: 1000, holdings: [] }, [
      { id: "d1", symbol: "X", side: "BUY", quantity: 10, price: 50 }, // avg 50
      { id: "d2", symbol: "X", side: "SELL", quantity: 4, price: 75, fee: 2 }, // pnl = (75-50)*4 - 2 = 98
    ]);
    expect(r.snapshots[1].realizedPnl).toBe(98);
    // Cash: 1000 - 500 (buy) + 300 (sell) - 2 (fee) = 798
    expect(r.finalState.cash).toBe(798);
    expect(r.finalState.holdings).toEqual([{ symbol: "X", quantity: 6, avgCost: 50 }]);
  });

  it("markPrices control snapshot holdings_value without triggering trades", () => {
    const r = simulateBrokerExecution({ cash: 1000, holdings: [] }, [
      { id: "d1", symbol: "X", side: "BUY", quantity: 5, price: 100 },
    ], { markPrices: { X: 150 } });
    const s = r.snapshots[0];
    expect(s.holdingsValue).toBe(750); // 5 * 150
    expect(s.totalValue).toBe(500 + 750);
    assertConsistent(s, { X: 150 });
  });

  it("zero mark price contributes 0 (never negative), snapshot stays consistent", () => {
    const r = simulateBrokerExecution({ cash: 1000, holdings: [] }, [
      { id: "d1", symbol: "X", side: "BUY", quantity: 5, price: 100 },
    ], { markPrices: { X: 0 } });
    const s = r.snapshots[0];
    expect(s.holdingsValue).toBe(0);
    expect(s.totalValue).toBe(s.cash);
    assertConsistent(s, { X: 0 });
  });

  it("negative / NaN mark prices are treated as 0 (no negative equity)", () => {
    const r = simulateBrokerExecution({ cash: 1000, holdings: [] }, [
      { id: "d1", symbol: "X", side: "BUY", quantity: 5, price: 100 },
    ], { markPrices: { X: -50 } });
    expect(r.snapshots[0].holdingsValue).toBe(0);
    assertConsistent(r.snapshots[0], { X: -50 });
  });

  it("invalid inputs are rejected with typed reasons", () => {
    const decisions: SimDecision[] = [
      { id: "a", symbol: "X", side: "BUY", quantity: 0, price: 10 },
      { id: "b", symbol: "X", side: "BUY", quantity: 1, price: Number.NaN },
      { id: "c", symbol: "X", side: "BUY", quantity: 1, price: -5 },
      { id: "d", symbol: "X", side: "BUY", quantity: 1, price: 10, fee: -1 },
      { id: "e", symbol: "X", side: "BUY", quantity: Number.POSITIVE_INFINITY, price: 10 },
    ];
    const r = simulateBrokerExecution(empty, decisions);
    expect(r.snapshots).toHaveLength(0);
    expect(r.rejections.map((x) => x.reason)).toEqual([
      "invalid_quantity",
      "invalid_price",
      "invalid_price",
      "invalid_fee",
      "invalid_quantity",
    ]);
    expect(r.finalState).toEqual(empty);
  });

  it("initial state validation throws for negative / NaN cash", () => {
    expect(() => simulateBrokerExecution({ cash: -1, holdings: [] }, [])).toThrow(/cash/);
    expect(() => simulateBrokerExecution({ cash: Number.NaN, holdings: [] }, [])).toThrow(/cash/);
    expect(() =>
      simulateBrokerExecution({ cash: 100, holdings: [{ symbol: "X", quantity: -1, avgCost: 1 }] }, []),
    ).toThrow(/quantity/);
  });

  it("every intermediate snapshot is internally consistent across a mixed sequence", () => {
    const r = simulateBrokerExecution({ cash: 1000, holdings: [] }, [
      { id: "1", symbol: "A", side: "BUY", quantity: 3, price: 100 },
      { id: "2", symbol: "B", side: "BUY", quantity: 2, price: 50 },
      { id: "3", symbol: "A", side: "SELL", quantity: 1, price: 110, fee: 1 },
      { id: "4", symbol: "A", side: "BUY", quantity: 10, price: 105 }, // partial fill
      { id: "5", symbol: "B", side: "SELL", quantity: 999, price: 40 }, // truncated
    ], { markPrices: { A: 108, B: 45 } });
    expect(r.snapshots).toHaveLength(5);
    for (const s of r.snapshots) assertConsistent(s, { A: 108, B: 45 });
    expect(r.finalState.cash).toBeGreaterThanOrEqual(0);
    for (const h of r.finalState.holdings) expect(h.quantity).toBeGreaterThan(0);
  });

  it("deterministic: same inputs produce identical results", () => {
    const inputs: SimDecision[] = [
      { id: "1", symbol: "A", side: "BUY", quantity: 3, price: 100 },
      { id: "2", symbol: "A", side: "SELL", quantity: 1, price: 110 },
    ];
    const r1 = simulateBrokerExecution({ cash: 500, holdings: [] }, inputs);
    const r2 = simulateBrokerExecution({ cash: 500, holdings: [] }, inputs);
    expect(r1).toEqual(r2);
  });

  it("fuzz: 200 random sequences never violate no-borrow / no-leverage / consistency", () => {
    let seed = 1;
    const rnd = () => {
      // xorshift32 — deterministic, fast, no dependency.
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return ((seed >>> 0) % 1_000_000) / 1_000_000;
    };
    for (let run = 0; run < 200; run++) {
      const startCash = Math.floor(rnd() * 10_000);
      const n = 1 + Math.floor(rnd() * 25);
      const decisions: SimDecision[] = Array.from({ length: n }, (_, i) => ({
        id: `${run}-${i}`,
        symbol: ["A", "B", "C"][Math.floor(rnd() * 3)],
        side: rnd() < 0.5 ? "BUY" : "SELL",
        quantity: Math.max(0.01, rnd() * 100),
        price: Math.max(0.01, rnd() * 500),
        fee: rnd() < 0.3 ? rnd() * 5 : 0,
      }));
      const r = simulateBrokerExecution({ cash: startCash, holdings: [] }, decisions);
      expect(r.finalState.cash).toBeGreaterThanOrEqual(0);
      for (const h of r.finalState.holdings) {
        expect(h.quantity).toBeGreaterThan(0);
      }
      for (const s of r.snapshots) assertConsistent(s);
    }
  });
});
