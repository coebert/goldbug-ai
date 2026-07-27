// Partial fills & liquidity constraints for simulateBrokerExecution.
//
// Verifies that:
//   - An availableVolume cap on a symbol truncates the fill and marks
//     the snapshot as `partial` with `truncationReason: "liquidity"`.
//   - A maxParticipationRate compounds with availableVolume.
//   - Zero available volume rejects with `no_liquidity`.
//   - Liquidity truncation takes priority over cash truncation in the
//     reported `truncationReason`.
//   - No-borrow / no-leverage invariants still hold under a random mix
//     of liquidity caps and cash constraints (200-run fuzz).

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { simulateBrokerExecution, type SimDecision, type SimState } from "@/lib/broker-simulator";
import { checkExecutionInvariants } from "@/lib/execution-invariants";

const start = (cash: number, holdings: SimState["holdings"] = []): SimState => ({ cash, holdings });

const buy = (id: string, symbol: string, qty: number, price: number, availableVolume?: number): SimDecision =>
  ({ id, symbol, side: "BUY", quantity: qty, price, availableVolume });
const sell = (id: string, symbol: string, qty: number, price: number, availableVolume?: number): SimDecision =>
  ({ id, symbol, side: "SELL", quantity: qty, price, availableVolume });

describe("broker-simulator — liquidity & partial fills", () => {
  it("truncates a BUY at per-symbol availableVolume and marks it partial", () => {
    const res = simulateBrokerExecution(
      start(10_000),
      [buy("d1", "ACME", 100, 10)],
      { liquidity: { availableVolume: { ACME: 40 } } },
    );
    expect(res.snapshots).toHaveLength(1);
    const s = res.snapshots[0];
    expect(s.fillQuantity).toBe(40);
    expect(s.requestedQuantity).toBe(100);
    expect(s.partial).toBe(true);
    expect(s.truncationReason).toBe("liquidity");
    expect(s.cash).toBeCloseTo(10_000 - 40 * 10, 9);
  });

  it("per-decision availableVolume overrides per-symbol map", () => {
    const res = simulateBrokerExecution(
      start(10_000),
      [buy("d1", "ACME", 100, 10, /* per-decision */ 25)],
      { liquidity: { availableVolume: { ACME: 90 } } },
    );
    expect(res.snapshots[0].fillQuantity).toBe(25);
    expect(res.snapshots[0].truncationReason).toBe("liquidity");
  });

  it("maxParticipationRate compounds with availableVolume", () => {
    // Cap = 200 * 0.10 = 20 units, well below the 100 requested.
    const res = simulateBrokerExecution(
      start(10_000),
      [buy("d1", "ACME", 100, 10)],
      { liquidity: { availableVolume: { ACME: 200 }, maxParticipationRate: 0.10 } },
    );
    expect(res.snapshots[0].fillQuantity).toBeCloseTo(20, 9);
    expect(res.snapshots[0].truncationReason).toBe("liquidity");
  });

  it("rejects with no_liquidity when availableVolume is zero", () => {
    const res = simulateBrokerExecution(
      start(10_000),
      [buy("d1", "ACME", 100, 10, 0)],
    );
    expect(res.snapshots).toHaveLength(0);
    expect(res.rejections).toHaveLength(1);
    expect(res.rejections[0].reason).toBe("no_liquidity");
  });

  it("rejects with no_liquidity when the post-cap fill is below minFillQuantity", () => {
    const res = simulateBrokerExecution(
      start(10_000),
      [buy("d1", "ACME", 100, 10, 5)],
      { liquidity: { minFillQuantity: 10 } },
    );
    expect(res.snapshots).toHaveLength(0);
    expect(res.rejections[0].reason).toBe("no_liquidity");
  });

  it("liquidity truncation takes priority over cash truncation in the reason", () => {
    // Cash allows only 30 units; liquidity caps at 40. Fill = 30, but reason
    // reports "liquidity" since that was the first (and dominant) constraint.
    const res = simulateBrokerExecution(
      start(300),
      [buy("d1", "ACME", 100, 10)],
      { liquidity: { availableVolume: { ACME: 40 } } },
    );
    expect(res.snapshots[0].fillQuantity).toBeCloseTo(30, 9);
    expect(res.snapshots[0].truncationReason).toBe("liquidity");
    expect(res.snapshots[0].partial).toBe(true);
  });

  it("pure cash truncation still reports truncationReason 'cash'", () => {
    const res = simulateBrokerExecution(
      start(200),
      [buy("d1", "ACME", 100, 10)],
    );
    expect(res.snapshots[0].fillQuantity).toBeCloseTo(20, 9);
    expect(res.snapshots[0].truncationReason).toBe("cash");
  });

  it("caps a SELL at available market volume", () => {
    const state = start(0, [{ symbol: "ACME", quantity: 100, avgCost: 10 }]);
    const res = simulateBrokerExecution(
      state,
      [sell("d1", "ACME", 100, 12)],
      { liquidity: { availableVolume: { ACME: 30 } } },
    );
    const s = res.snapshots[0];
    expect(s.fillQuantity).toBe(30);
    expect(s.truncationReason).toBe("liquidity");
    expect(s.partial).toBe(true);
    // Remaining held after partial sell.
    expect(s.holdings.find((h) => h.symbol === "ACME")?.quantity).toBeCloseTo(70, 9);
  });

  it("marks full fills as non-partial with truncationReason null", () => {
    const res = simulateBrokerExecution(
      start(10_000),
      [buy("d1", "ACME", 10, 10)],
      { liquidity: { availableVolume: { ACME: 1_000 } } },
    );
    expect(res.snapshots[0].partial).toBe(false);
    expect(res.snapshots[0].truncationReason).toBeNull();
  });

  it("unconstrained symbols behave exactly as before", () => {
    const res = simulateBrokerExecution(
      start(10_000),
      [buy("d1", "ACME", 5, 10)],
    );
    expect(res.snapshots[0].fillQuantity).toBe(5);
    expect(res.snapshots[0].partial).toBe(false);
    expect(res.snapshots[0].truncationReason).toBeNull();
    expect(res.snapshots[0].requestedQuantity).toBe(5);
  });

  it("fuzz: invariants hold under random liquidity + cash constraints", () => {
    fc.assert(
      fc.property(
        fc.record({
          cash: fc.double({ min: 100, max: 100_000, noNaN: true, noDefaultInfinity: true }),
          price: fc.double({ min: 1, max: 500, noNaN: true, noDefaultInfinity: true }),
          reqQty: fc.double({ min: 1, max: 5_000, noNaN: true, noDefaultInfinity: true }),
          availVol: fc.double({ min: 0.01, max: 5_000, noNaN: true, noDefaultInfinity: true }),
          rate: fc.double({ min: 0.001, max: 1, noNaN: true, noDefaultInfinity: true }),
        }),
        (p) => {
          const decisions: SimDecision[] = [buy("d1", "ACME", p.reqQty, p.price, p.availVol)];
          const res = simulateBrokerExecution(
            start(p.cash),
            decisions,
            { liquidity: { maxParticipationRate: p.rate } },
          );
          const report = checkExecutionInvariants({
            initial: start(p.cash),
            decisions,
            snapshots: res.snapshots,
            rejections: res.rejections,
          });
          expect(report.ok).toBe(true);
          if (res.snapshots.length > 0) {
            const s = res.snapshots[0];
            // Fill never exceeds liquidity cap.
            expect(s.fillQuantity).toBeLessThanOrEqual(p.availVol * p.rate + 1e-9);
            // Fill never exceeds requested.
            expect(s.fillQuantity).toBeLessThanOrEqual(p.reqQty + 1e-9);
            // Partial flag matches fill vs request.
            expect(s.partial).toBe(s.fillQuantity < p.reqQty - 1e-9);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
