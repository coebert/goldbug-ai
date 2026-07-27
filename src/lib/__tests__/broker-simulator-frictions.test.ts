// Transaction costs & slippage in simulateBrokerExecution.
//
// The friction model must move fills adversely (BUYs pay up, SELLs
// receive less), charge commissions with a min-floor, apply buy-side
// tax, and — crucially — never let realistic trading frictions cause
// an execution-invariant violation (no borrow, no leverage, snapshot
// consistency, no negative cash).

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  simulateBrokerExecution,
  type Frictions,
  type SimDecision,
  type SimState,
} from "../broker-simulator";
import { assertExecutionInvariants } from "../execution-invariants";

const startState = (cash = 10_000): SimState => ({ cash, holdings: [] });

describe("simulateBrokerExecution — frictions applied to fills", () => {
  it("BUY fills above quote by slippageBps; SELL fills below", () => {
    const f: Frictions = { slippageBps: 20 }; // 0.20%
    const r = simulateBrokerExecution(
      startState(10_000),
      [
        { id: "b1", symbol: "AAA", side: "BUY", quantity: 10, price: 100 },
        { id: "s1", symbol: "AAA", side: "SELL", quantity: 4, price: 100 },
      ],
      { frictions: f },
    );
    // BUY at 100*(1+0.002) = 100.20
    expect(r.snapshots[0].fillPrice).toBeCloseTo(100.2, 10);
    // SELL at 100*(1-0.002) = 99.80
    expect(r.snapshots[1].fillPrice).toBeCloseTo(99.8, 10);
    // avgCost tracks execution price, so realizedPnl reflects both slips
    // + zero commissions: (99.80 - 100.20)*4 = -1.6
    expect(r.snapshots[1].realizedPnl).toBeCloseTo(-1.6, 10);
  });

  it("commission floor dominates when notional * bps < minCommission", () => {
    const f: Frictions = { commissionBps: 5, minCommission: 2 };
    const r = simulateBrokerExecution(
      startState(1_000),
      [{ id: "b1", symbol: "AAA", side: "BUY", quantity: 1, price: 50 }],
      { frictions: f },
    );
    // notional = 50, 5bps = 0.025, minCommission wins at 2.
    expect(r.snapshots[0].fee).toBeCloseTo(2, 10);
    expect(r.snapshots[0].cash).toBeCloseTo(1000 - 50 - 2, 10);
  });

  it("commission bps dominates once notional * bps > minCommission", () => {
    const f: Frictions = { commissionBps: 10, minCommission: 1 };
    const r = simulateBrokerExecution(
      startState(10_000),
      [{ id: "b1", symbol: "AAA", side: "BUY", quantity: 20, price: 100 }],
      { frictions: f },
    );
    // notional = 2000, 10bps = 2 > minCommission 1.
    expect(r.snapshots[0].fee).toBeCloseTo(2, 10);
    expect(r.snapshots[0].cash).toBeCloseTo(10_000 - 2_000 - 2, 10);
  });

  it("buy-side tax (stamp duty) applies to BUYs but NOT to SELLs", () => {
    const f: Frictions = { buyTaxBps: 50 }; // 0.50%
    const r = simulateBrokerExecution(
      startState(10_000),
      [
        { id: "b1", symbol: "AAA", side: "BUY", quantity: 10, price: 100 },
        { id: "s1", symbol: "AAA", side: "SELL", quantity: 10, price: 100 },
      ],
      { frictions: f },
    );
    // BUY: fee = 1000 * 0.005 = 5
    expect(r.snapshots[0].fee).toBeCloseTo(5, 10);
    // SELL: no tax → fee = 0
    expect(r.snapshots[1].fee).toBeCloseTo(0, 10);
  });

  it("impactPerUnit widens the effective spread as size grows", () => {
    const f: Frictions = { impactPerUnit: 0.01 }; // 1p per unit
    const r = simulateBrokerExecution(
      startState(1_000_000),
      [
        { id: "b1", symbol: "AAA", side: "BUY", quantity: 100, price: 50 },
      ],
      { frictions: f },
    );
    // effPrice = 50 + 0.01 * 100 = 51
    expect(r.snapshots[0].fillPrice).toBeCloseTo(51, 10);
  });

  it("per-decision `fee` still adds on top of commission + tax", () => {
    const f: Frictions = { commissionBps: 10, buyTaxBps: 50 };
    const r = simulateBrokerExecution(
      startState(10_000),
      [{ id: "b1", symbol: "AAA", side: "BUY", quantity: 10, price: 100, fee: 7 }],
      { frictions: f },
    );
    // notional 1000; commission 10bps = 1; tax 50bps = 5; baseFee 7 → 13
    expect(r.snapshots[0].fee).toBeCloseTo(13, 10);
  });
});

describe("simulateBrokerExecution — frictions never violate invariants", () => {
  it("truncates BUYs so the fully-loaded spend (slip+comm+tax) still fits cash", () => {
    const f: Frictions = {
      slippageBps: 25,
      commissionBps: 15,
      buyTaxBps: 50,
      minCommission: 1,
      impactPerUnit: 0.02,
    };
    const initial = startState(250);
    const decisions: SimDecision[] = [
      // Requests 100 units at £2 quote — nominally £200, but frictions
      // + impact drive true cost well above £250 → engine must truncate.
      { id: "b1", symbol: "AAA", side: "BUY", quantity: 100, price: 2 },
    ];
    const r = simulateBrokerExecution(initial, decisions, { frictions: f });
    // Never borrowed:
    expect(r.snapshots[0].cash).toBeGreaterThanOrEqual(0);
    // And the invariants checker agrees.
    assertExecutionInvariants({
      initial,
      decisions,
      snapshots: r.snapshots,
      rejections: r.rejections,
    });
  });

  it("rejects when fixed commission floor + baseFee alone exceed cash", () => {
    const f: Frictions = { minCommission: 100 };
    const r = simulateBrokerExecution(
      startState(50),
      [{ id: "b1", symbol: "AAA", side: "BUY", quantity: 1, price: 10 }],
      { frictions: f },
    );
    expect(r.snapshots).toHaveLength(0);
    expect(r.rejections[0].reason).toBe("insufficient_cash");
    expect(r.finalState.cash).toBe(50);
  });

  it("would_borrow rejection under frictions when truncateBuysToCash=false", () => {
    const f: Frictions = { slippageBps: 100, commissionBps: 20 };
    const r = simulateBrokerExecution(
      startState(100),
      [{ id: "b1", symbol: "AAA", side: "BUY", quantity: 10, price: 20 }],
      { frictions: f, truncateBuysToCash: false },
    );
    expect(r.rejections[0].reason).toBe("would_borrow");
    expect(r.finalState).toEqual({ cash: 100, holdings: [] });
  });

  it("SELL fee > cash+proceeds is rejected as insufficient_cash", () => {
    const f: Frictions = { minCommission: 500 };
    const r = simulateBrokerExecution(
      { cash: 10, holdings: [{ symbol: "AAA", quantity: 1, avgCost: 50 }] },
      [{ id: "s1", symbol: "AAA", side: "SELL", quantity: 1, price: 100 }],
      { frictions: f },
    );
    expect(r.rejections[0].reason).toBe("insufficient_cash");
  });

  it("realizedPnl reflects slippage + commission on round trip (loss even at flat quote)", () => {
    const f: Frictions = { slippageBps: 10, commissionBps: 5 };
    const r = simulateBrokerExecution(
      startState(10_000),
      [
        { id: "b1", symbol: "AAA", side: "BUY", quantity: 10, price: 100 },
        { id: "s1", symbol: "AAA", side: "SELL", quantity: 10, price: 100 },
      ],
      { frictions: f },
    );
    // Round-trip at flat quote MUST lose money under frictions.
    expect(r.snapshots[1].realizedPnl).toBeLessThan(0);
    // Ledger stays consistent.
    assertExecutionInvariants({
      initial: startState(10_000),
      decisions: [
        { id: "b1", symbol: "AAA", side: "BUY", quantity: 10, price: 100 },
        { id: "s1", symbol: "AAA", side: "SELL", quantity: 10, price: 100 },
      ],
      snapshots: r.snapshots,
      rejections: r.rejections,
    });
  });

  it("fuzz: random decision streams × random friction models never break invariants", () => {
    const symbolArb = fc.constantFrom("AAA", "BBB", "CCC");
    const decisionArb = fc.record({
      id: fc.string({ minLength: 1, maxLength: 6 }).filter((s) => s.trim().length > 0),
      symbol: symbolArb,
      side: fc.constantFrom<"BUY" | "SELL">("BUY", "SELL"),
      quantity: fc.double({ min: 0.01, max: 100, noNaN: true, noDefaultInfinity: true }),
      price: fc.double({ min: 0.5, max: 500, noNaN: true, noDefaultInfinity: true }),
      fee: fc.double({ min: 0, max: 3, noNaN: true, noDefaultInfinity: true }),
    });
    const frictionsArb: fc.Arbitrary<Frictions> = fc.record({
      commissionBps: fc.double({ min: 0, max: 50, noNaN: true, noDefaultInfinity: true }),
      minCommission: fc.double({ min: 0, max: 5, noNaN: true, noDefaultInfinity: true }),
      buyTaxBps: fc.double({ min: 0, max: 50, noNaN: true, noDefaultInfinity: true }),
      slippageBps: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
      impactPerUnit: fc.double({ min: 0, max: 0.05, noNaN: true, noDefaultInfinity: true }),
    });

    fc.assert(
      fc.property(
        fc.double({ min: 100, max: 100_000, noNaN: true, noDefaultInfinity: true }),
        fc.array(decisionArb, { minLength: 0, maxLength: 30 }),
        frictionsArb,
        (startingCash, rawDecisions, frictions) => {
          const seen = new Set<string>();
          const uniq: SimDecision[] = [];
          for (let i = 0; i < rawDecisions.length; i += 1) {
            const d = { ...rawDecisions[i], id: `${rawDecisions[i].id}-${i}` };
            if (seen.has(d.id)) continue;
            seen.add(d.id);
            uniq.push(d);
          }
          const initial = startState(startingCash);
          const res = simulateBrokerExecution(initial, uniq, { frictions });
          assertExecutionInvariants({
            initial,
            decisions: uniq,
            snapshots: res.snapshots,
            rejections: res.rejections,
          });
          // Extra terminal invariants over cash & positions.
          expect(res.finalState.cash).toBeGreaterThanOrEqual(0);
          for (const h of res.finalState.holdings) {
            expect(h.quantity).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("simulateBrokerExecution — frictions omitted preserves legacy behaviour", () => {
  it("no frictions option → byte-identical results vs a re-run without it", () => {
    const decisions: SimDecision[] = [
      { id: "1", symbol: "A", side: "BUY", quantity: 3, price: 100 },
      { id: "2", symbol: "A", side: "SELL", quantity: 1, price: 110, fee: 1 },
    ];
    const r1 = simulateBrokerExecution({ cash: 500, holdings: [] }, decisions);
    const r2 = simulateBrokerExecution({ cash: 500, holdings: [] }, decisions, {});
    expect(r1).toEqual(r2);
  });
});
