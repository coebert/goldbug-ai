// Worst-case friction verification for the order-sizing pipeline.
//
// `broker-simulator` already models transaction costs and slippage
// (commissionBps + minCommission floor, buy-side tax, fixed slippageBps
// and linear impactPerUnit). What was never pinned down is whether the
// *sizing* caps that the trading engine computes frictionlessly still
// hold once those costs are charged at punitive levels.
//
// The property under test: for any spend the sizer authorises, executing
// it through the simulator under the worst-case cost model must
//   - never borrow (cash >= 0),
//   - never short (quantity >= 0),
//   - never spend more than the authorised budget (fees included),
//   - never breach the per-name NAV cap on realised notional,
//   - keep snapshots internally consistent (total = cash + holdings),
//   - stay deterministic and NaN-free.
//
// Frictions can only ever make a fill *smaller*, so the cap direction is
// one-sided — that is exactly what these tests lock in.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  simulateBrokerExecution,
  type Frictions,
  type SimDecision,
  type SimState,
} from "../broker-simulator";
import { assertExecutionInvariants } from "../execution-invariants";
import { resolveAggressiveness, aggressiveBuySpend } from "../risk-aggressiveness";
import { RISK_LEVELS, riskPresetConfig } from "../risk-presets";
import { volTargetSize } from "../sizing/vol-target";
import { sizeAgainstClusterCap } from "../sizing/correlation-cluster";

/** Deliberately brutal: 1% commission, £15 floor, 50bp stamp duty, 1% slip. */
const WORST_CASE: Frictions = {
  commissionBps: 100,
  minCommission: 15,
  buyTaxBps: 50,
  slippageBps: 100,
  impactPerUnit: 0.05,
};

const NAV = 100_000;
const PER_NAME_CAP = 0.25;

/** The engine's frictionless sizer: dial → vol-target → cluster cap → cash. */
function authoriseSpend(args: {
  level: number;
  nav: number;
  cash: number;
  baseFraction: number;
  realizedVol: number;
  clusterCap?: number;
  currentWeights?: Record<string, number>;
}): number {
  const agg = resolveAggressiveness(riskPresetConfig(args.level));
  const vol = volTargetSize({
    baseFraction: args.baseFraction,
    targetVol: 0.15,
    realizedVol: args.realizedVol,
    maxFraction: PER_NAME_CAP,
  });
  const cluster = sizeAgainstClusterCap({
    currentWeights: args.currentWeights ?? {},
    proposedSymbol: "AAA",
    proposedWeight: vol.fraction,
    clusters: [["AAA", "BBB"]],
    clusterCap: args.clusterCap ?? 1,
  });
  const target = cluster.allowed_weight * args.nav;
  return Math.max(0, Math.min(aggressiveBuySpend(target, agg), args.cash));
}

/** Turn an authorised spend into a ticket at the quoted price. */
function ticket(spend: number, price: number): SimDecision[] {
  const qty = spend / price;
  return qty > 0
    ? [{ id: "b1", symbol: "AAA", side: "BUY", quantity: qty, price }]
    : [];
}

const start = (cash: number): SimState => ({ cash, holdings: [] });

describe("worst-case frictions — authorised spend is never exceeded", () => {
  it("charges fees and slippage inside the budget rather than on top of it", () => {
    const spend = authoriseSpend({
      level: 3, nav: NAV, cash: NAV, baseFraction: 0.2, realizedVol: 0.15,
    });
    const res = simulateBrokerExecution(start(spend), ticket(spend, 100), {
      frictions: WORST_CASE,
    });
    const snap = res.snapshots[0];
    expect(snap).toBeDefined();
    // Everything (notional + commission + tax) came out of the budget.
    expect(res.finalState.cash).toBeGreaterThanOrEqual(0);
    expect(snap.fillQuantity * snap.fillPrice + snap.fee).toBeLessThanOrEqual(spend + 1e-6);
    // Frictions can only shrink the fill, never grow it.
    expect(snap.fillQuantity).toBeLessThanOrEqual(spend / 100 + 1e-9);
    expect(snap.partial).toBe(true);
    expect(snap.truncationReason).toBe("cash");
    assertExecutionInvariants(start(spend), res);
  });

  it("keeps the realised position inside the per-name NAV cap for every risk level", () => {
    for (const level of RISK_LEVELS) {
      const spend = authoriseSpend({
        level, nav: NAV, cash: NAV, baseFraction: 0.4, realizedVol: 0.1,
      });
      const res = simulateBrokerExecution(start(NAV), ticket(spend, 100), {
        frictions: WORST_CASE,
        markPrices: { AAA: 100 },
      });
      const snap = res.snapshots[0];
      const notional = snap ? snap.fillQuantity * 100 : 0;
      expect(notional).toBeLessThanOrEqual(PER_NAME_CAP * NAV + 1e-6);
      expect(res.finalState.cash).toBeGreaterThanOrEqual(0);
      assertExecutionInvariants(start(NAV), res);
    }
  });

  it("respects the cluster cap after costs when a correlated name is already held", () => {
    const spend = authoriseSpend({
      level: 5, nav: NAV, cash: NAV, baseFraction: 0.2, realizedVol: 0.1,
      clusterCap: 0.3, currentWeights: { BBB: 0.25 },
    });
    // Cluster headroom is 5% of NAV; costs must not push us past it.
    expect(spend).toBeLessThanOrEqual(0.05 * NAV + 1e-6);
    const res = simulateBrokerExecution(start(NAV), ticket(spend, 50), {
      frictions: WORST_CASE,
      markPrices: { AAA: 50 },
    });
    const snap = res.snapshots[0];
    expect(snap.fillQuantity * 50).toBeLessThanOrEqual(0.05 * NAV + 1e-6);
    assertExecutionInvariants(start(NAV), res);
  });

  it("rejects rather than borrows when the minimum commission alone exceeds cash", () => {
    const res = simulateBrokerExecution(
      start(5),
      [{ id: "b1", symbol: "AAA", side: "BUY", quantity: 1, price: 1 }],
      { frictions: WORST_CASE },
    );
    expect(res.snapshots).toHaveLength(0);
    expect(res.rejections[0]?.reason).toBe("insufficient_cash");
    expect(res.finalState.cash).toBe(5);
  });

  it("never sells more than is held, even when slippage guts the proceeds", () => {
    const held: SimState = { cash: 0, holdings: [{ symbol: "AAA", quantity: 3, avgCost: 100 }] };
    const res = simulateBrokerExecution(
      held,
      [{ id: "s1", symbol: "AAA", side: "SELL", quantity: 10, price: 100 }],
      { frictions: WORST_CASE, markPrices: { AAA: 100 } },
    );
    expect(res.finalState.holdings.find((h) => h.symbol === "AAA")?.quantity ?? 0).toBe(0);
    expect(res.finalState.cash).toBeGreaterThanOrEqual(0);
    // Sold below the quote: slippage + impact are adverse on the sell side.
    expect(res.snapshots[0].fillPrice).toBeLessThan(100);
    assertExecutionInvariants(held, res);
  });
});

describe("worst-case frictions — fuzz", () => {
  const frictionArb = fc.record({
    commissionBps: fc.double({ min: 0, max: 500, noNaN: true }),
    minCommission: fc.double({ min: 0, max: 100, noNaN: true }),
    buyTaxBps: fc.double({ min: 0, max: 200, noNaN: true }),
    slippageBps: fc.double({ min: 0, max: 500, noNaN: true }),
    impactPerUnit: fc.double({ min: 0, max: 0.5, noNaN: true }),
  });

  it("holds every invariant for arbitrary cost models, prices, and risk levels", () => {
    fc.assert(
      fc.property(
        frictionArb,
        fc.constantFrom(...RISK_LEVELS),
        fc.double({ min: 0.5, max: 500, noNaN: true }),
        fc.double({ min: 1000, max: 250_000, noNaN: true }),
        fc.double({ min: 0.01, max: 1.5, noNaN: true }),
        (frictions, level, price, cash, vol) => {
          const spend = authoriseSpend({
            level, nav: cash, cash, baseFraction: 0.2, realizedVol: vol,
          });
          expect(Number.isFinite(spend)).toBe(true);
          expect(spend).toBeGreaterThanOrEqual(0);
          expect(spend).toBeLessThanOrEqual(PER_NAME_CAP * cash + 1e-6);

          const state = start(cash);
          const res = simulateBrokerExecution(state, ticket(spend, price), {
            frictions,
            markPrices: { AAA: price },
          });
          assertExecutionInvariants(state, res);
          for (const s of res.snapshots) {
            expect(Number.isFinite(s.fillQuantity)).toBe(true);
            expect(Number.isFinite(s.fee)).toBe(true);
            expect(s.fee).toBeGreaterThanOrEqual(0);
            expect(s.fillQuantity).toBeGreaterThanOrEqual(0);
            // Fills can only shrink under cost: never more units than the
            // frictionless budget would have bought.
            expect(s.fillQuantity).toBeLessThanOrEqual(spend / price + 1e-6);
            expect(s.totalValue).toBeCloseTo(s.cash + s.holdingsValue, 6);
          }
          expect(res.finalState.cash).toBeGreaterThanOrEqual(-1e-9);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("is monotone in cost: heavier frictions never buy more units", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 300, noNaN: true }),
        fc.double({ min: 0, max: 200, noNaN: true }),
        fc.double({ min: 0, max: 200, noNaN: true }),
        (price, bpsA, extra) => {
          const spend = authoriseSpend({
            level: 3, nav: NAV, cash: NAV, baseFraction: 0.2, realizedVol: 0.2,
          });
          const qtyAt = (bps: number) => {
            const res = simulateBrokerExecution(start(spend), ticket(spend, price), {
              frictions: { commissionBps: bps, slippageBps: bps },
            });
            return res.snapshots[0]?.fillQuantity ?? 0;
          };
          expect(qtyAt(bpsA + extra)).toBeLessThanOrEqual(qtyAt(bpsA) + 1e-9);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("is deterministic: identical inputs give byte-identical results", () => {
    const spend = authoriseSpend({
      level: 4, nav: NAV, cash: NAV, baseFraction: 0.3, realizedVol: 0.25,
    });
    const run = () =>
      JSON.stringify(
        simulateBrokerExecution(start(NAV), ticket(spend, 73.21), {
          frictions: WORST_CASE,
          markPrices: { AAA: 73.21 },
        }),
      );
    expect(run()).toBe(run());
  });
});
