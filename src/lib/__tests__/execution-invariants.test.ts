// Automated invariant checks over the broker execution engine.
// Covers: no borrowing, no leverage/shorting, positions never exceed
// available cash, snapshot totals stay internally consistent, and
// every violation type is detected by the checker.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  simulateBrokerExecution,
  type SimDecision,
  type SimSnapshot,
  type SimState,
} from "../broker-simulator";
import {
  assertExecutionInvariants,
  checkExecutionInvariants,
} from "../execution-invariants";

const startState = (cash = 1_000): SimState => ({ cash, holdings: [] });

describe("execution-invariants — happy path over broker-simulator", () => {
  it("passes for an empty run", () => {
    const res = simulateBrokerExecution(startState(1_000), []);
    assertExecutionInvariants({
      initial: startState(1_000),
      decisions: [],
      snapshots: res.snapshots,
      rejections: res.rejections,
    });
  });

  it("passes for a simple buy-then-sell cycle", () => {
    const decisions: SimDecision[] = [
      { id: "d1", symbol: "AAA", side: "BUY", quantity: 10, price: 50, fee: 1 },
      { id: "d2", symbol: "AAA", side: "SELL", quantity: 4, price: 55, fee: 1 },
    ];
    const res = simulateBrokerExecution(startState(1_000), decisions, {
      markPrices: { AAA: 55 },
    });
    assertExecutionInvariants({
      initial: startState(1_000),
      decisions,
      snapshots: res.snapshots,
      rejections: res.rejections,
      markPrices: { AAA: 55 },
    });
  });

  it("passes even when the engine truncates a would-borrow buy", () => {
    const decisions: SimDecision[] = [
      // Would need £2000 cash but only £100 available.
      { id: "d1", symbol: "AAA", side: "BUY", quantity: 20, price: 100, fee: 0 },
    ];
    const res = simulateBrokerExecution(startState(100), decisions);
    const report = checkExecutionInvariants({
      initial: startState(100),
      decisions,
      snapshots: res.snapshots,
      rejections: res.rejections,
    });
    expect(report.ok).toBe(true);
    // Cash after truncated buy is (near) zero — never negative.
    for (const s of res.snapshots) expect(s.cash).toBeGreaterThanOrEqual(0);
  });
});

describe("execution-invariants — detects hand-crafted violations", () => {
  const baseSnap = (over: Partial<SimSnapshot>): SimSnapshot => ({
    step: 1,
    decisionId: "d1",
    symbol: "AAA",
    side: "BUY",
    cash: 100,
    holdings: [],
    holdingsValue: 0,
    totalValue: 100,
    realizedPnl: 0,
    fillQuantity: 0,
    fillPrice: 0,
    fee: 0,
    requestedQuantity: 0,
    partial: false,
    truncationReason: null,
    expectedPrice: 0,
    slippageBps: 0,
    participationRate: null,
    liquidityAdjustedSlippageBps: null,
    ...over,
  });


  });

  it("flags negative cash (borrowing)", () => {
    const report = checkExecutionInvariants({
      initial: startState(100),
      decisions: [],
      snapshots: [baseSnap({ cash: -5, totalValue: -5 })],
      rejections: [],
    });
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.code === "NEGATIVE_CASH")).toBe(true);
  });

  it("flags negative holding quantity (shorting/leverage)", () => {
    const report = checkExecutionInvariants({
      initial: startState(100),
      decisions: [],
      snapshots: [
        baseSnap({
          cash: 100,
          holdings: [{ symbol: "AAA", quantity: -1, avgCost: 10 }],
          holdingsValue: -10,
          totalValue: 90,
        }),
      ],
      rejections: [],
    });
    expect(report.violations.some((v) => v.code === "NEGATIVE_QUANTITY")).toBe(true);
  });

  it("flags totalValue drift", () => {
    const report = checkExecutionInvariants({
      initial: startState(100),
      decisions: [],
      snapshots: [
        baseSnap({
          cash: 50,
          holdings: [{ symbol: "AAA", quantity: 1, avgCost: 40 }],
          holdingsValue: 40,
          totalValue: 999, // wrong
        }),
      ],
      rejections: [],
    });
    expect(report.violations.some((v) => v.code === "SNAPSHOT_TOTAL_DRIFT")).toBe(true);
  });

  it("flags a BUY that overspends prior cash", () => {
    const report = checkExecutionInvariants({
      initial: startState(100),
      decisions: [
        { id: "d1", symbol: "AAA", side: "BUY", quantity: 5, price: 50, fee: 0 },
      ],
      snapshots: [
        baseSnap({
          cash: -150, // buy spent 250 but had only 100
          holdings: [{ symbol: "AAA", quantity: 5, avgCost: 50 }],
          holdingsValue: 250,
          totalValue: 100,
          fillQuantity: 5,
          fillPrice: 50,
        }),
      ],
      rejections: [],
    });
    // Both NEGATIVE_CASH and BUY_EXCEEDS_PRIOR_CASH should trip.
    const codes = report.violations.map((v) => v.code);
    expect(codes).toContain("NEGATIVE_CASH");
    expect(codes).toContain("BUY_EXCEEDS_PRIOR_CASH");
  });

  it("flags non-increasing step ordering across multiple snapshots", () => {
    const report = checkExecutionInvariants({
      initial: startState(100),
      decisions: [],
      snapshots: [baseSnap({ step: 2 }), baseSnap({ step: 2 })],
      rejections: [],
    });
    expect(report.violations.some((v) => v.code === "STEP_ORDERING")).toBe(true);
  });

  it("assertExecutionInvariants throws with all violation codes in the message", () => {
    expect(() =>
      assertExecutionInvariants({
        initial: startState(100),
        decisions: [],
        snapshots: [baseSnap({ cash: -1, totalValue: -1 })],
        rejections: [],
      }),
    ).toThrow(/NEGATIVE_CASH/);
  });
});

describe("execution-invariants — property test over random decision streams", () => {
  it("simulateBrokerExecution output always satisfies every invariant", () => {
    const symbolArb = fc.constantFrom("AAA", "BBB", "CCC");
    const decisionArb = fc.record({
      id: fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim().length > 0),
      symbol: symbolArb,
      side: fc.constantFrom<"BUY" | "SELL">("BUY", "SELL"),
      quantity: fc.double({ min: 0.01, max: 100, noNaN: true, noDefaultInfinity: true }),
      price: fc.double({ min: 0.01, max: 500, noNaN: true, noDefaultInfinity: true }),
      fee: fc.double({ min: 0, max: 5, noNaN: true, noDefaultInfinity: true }),
    });

    fc.assert(
      fc.property(
        fc.double({ min: 100, max: 100_000, noNaN: true, noDefaultInfinity: true }),
        fc.array(decisionArb, { minLength: 0, maxLength: 40 }),
        (startingCash, decisions) => {
          // Deduplicate decision ids to keep snapshot correlation clean.
          const seen = new Set<string>();
          const uniq: SimDecision[] = [];
          for (let i = 0; i < decisions.length; i += 1) {
            const d = { ...decisions[i], id: `${decisions[i].id}-${i}` };
            if (seen.has(d.id)) continue;
            seen.add(d.id);
            uniq.push(d);
          }
          const initial = startState(startingCash);
          const res = simulateBrokerExecution(initial, uniq);
          const report = checkExecutionInvariants({
            initial,
            decisions: uniq,
            snapshots: res.snapshots,
            rejections: res.rejections,
          });
          if (!report.ok) {
            // Surface details for debugging when fast-check shrinks a failure.
            throw new Error(
              `invariants failed:\n${report.violations
                .map((v) => `${v.code}: ${v.message}`)
                .join("\n")}`,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
