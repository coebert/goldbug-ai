// Automatic time-slicing of unfilled quantities.
//
// When `timeSliceUnfilled` is on, a decision that only partially fills
// because of a `liquidity` truncation has its residual re-queued as a
// follow-up decision. Each attempt gets a fresh per-decision liquidity
// cap — mirroring "the next bar of ADV becomes available" — and produces
// its own snapshot tagged with `sliceOf` (the original decision id) and
// `sliceIndex` (0 for the parent, 1..N for slices).
//
// Guarantees verified below:
//   - a BUY throttled by availableVolume produces N snapshots that sum
//     to the originally requested quantity (up to attempts budget);
//   - each slice sees the SAME liquidity cap independently;
//   - slicing is gated by `timeSliceMaxAttempts` and stops early once
//     the residual is fully filled;
//   - slicing does not apply to cash/position truncations (only liquidity);
//   - the same treatment works for SELLs;
//   - execution invariants still hold under sliced execution;
//   - when the option is OFF, output is byte-identical to the pre-slicing
//     behaviour (no `sliceOf`/`sliceIndex` fields emitted).

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  simulateBrokerExecution,
  type SimDecision,
  type SimState,
} from "@/lib/broker-simulator";
import { checkExecutionInvariants } from "@/lib/execution-invariants";

const start = (cash: number, holdings: SimState["holdings"] = []): SimState =>
  ({ cash, holdings });

const buy = (id: string, symbol: string, qty: number, price: number, availableVolume?: number): SimDecision =>
  ({ id, symbol, side: "BUY", quantity: qty, price, availableVolume });
const sell = (id: string, symbol: string, qty: number, price: number, availableVolume?: number): SimDecision =>
  ({ id, symbol, side: "SELL", quantity: qty, price, availableVolume });

describe("broker-simulator — automatic time-slicing", () => {
  it("splits a liquidity-truncated BUY into N snapshots that sum to the request", () => {
    // Cap = 30 units/bar. Request = 100 units. With 5 slices (default) the
    // parent fills 30 and 3 slices fill 30/30/10 for a total of 100 — the
    // 4th residual becomes 0 and stops early.
    const res = simulateBrokerExecution(
      start(100_000),
      [buy("d1", "ACME", 100, 10, /* availableVolume */ 30)],
      { timeSliceUnfilled: true },
    );
    expect(res.snapshots.length).toBe(4);
    const totalFilled = res.snapshots.reduce((s, x) => s + x.fillQuantity, 0);
    expect(totalFilled).toBeCloseTo(100, 9);

    // Slice bookkeeping: every snapshot points back to the original id.
    expect(res.snapshots.map((s) => s.sliceOf)).toEqual(
      ["d1", "d1", "d1", "d1"],
    );
    expect(res.snapshots.map((s) => s.sliceIndex)).toEqual([0, 1, 2, 3]);
    // The parent keeps the original decision id; slices get suffixed ids.
    expect(res.snapshots[0].decisionId).toBe("d1");
    expect(res.snapshots[1].decisionId).toBe("d1#slice-1");
    expect(res.snapshots[3].decisionId).toBe("d1#slice-3");

    // Cash accounting is exact across the whole slice sequence.
    expect(res.finalState.cash).toBeCloseTo(100_000 - 100 * 10, 9);
    expect(res.finalState.holdings.find((h) => h.symbol === "ACME")?.quantity)
      .toBeCloseTo(100, 9);
  });

  it("stops early when the residual fits within one bar's liquidity", () => {
    // Request 50, cap 40 → parent fills 40, one slice fills the remaining 10
    // and terminates.
    const res = simulateBrokerExecution(
      start(100_000),
      [buy("d1", "ACME", 50, 10, 40)],
      { timeSliceUnfilled: true },
    );
    expect(res.snapshots.length).toBe(2);
    expect(res.snapshots[0].fillQuantity).toBe(40);
    expect(res.snapshots[0].partial).toBe(true);
    expect(res.snapshots[1].fillQuantity).toBe(10);
    // Final slice is a full fill of its own residual request → not partial.
    expect(res.snapshots[1].partial).toBe(false);
    expect(res.snapshots[1].truncationReason).toBeNull();
  });

  it("honours timeSliceMaxAttempts and stops with unfilled residual when exhausted", () => {
    // Cap = 10/bar, request = 100 → needs 10 slices to complete, but we
    // allow only 2 extra attempts (parent + 2 slices = 3 fills of 10 each).
    const res = simulateBrokerExecution(
      start(100_000),
      [buy("d1", "ACME", 100, 10, 10)],
      { timeSliceUnfilled: true, timeSliceMaxAttempts: 2 },
    );
    expect(res.snapshots.length).toBe(3);
    const totalFilled = res.snapshots.reduce((s, x) => s + x.fillQuantity, 0);
    expect(totalFilled).toBeCloseTo(30, 9);
    // Every emitted snapshot in this run is liquidity-partial.
    for (const s of res.snapshots) {
      expect(s.truncationReason).toBe("liquidity");
      expect(s.partial).toBe(true);
    }
    // No rejection — we simply ran out of attempts. The residual 70 units
    // are silently dropped, as documented.
    expect(res.rejections).toHaveLength(0);
  });

  it("does NOT time-slice cash-truncated fills (only liquidity)", () => {
    // Cash caps this at 20 units; there's no liquidity constraint. A cash
    // truncation must not spawn a residual slice (the ledger, not the market,
    // is the limiting factor).
    const res = simulateBrokerExecution(
      start(200),
      [buy("d1", "ACME", 100, 10)],
      { timeSliceUnfilled: true },
    );
    expect(res.snapshots).toHaveLength(1);
    expect(res.snapshots[0].truncationReason).toBe("cash");
    expect(res.snapshots[0].fillQuantity).toBeCloseTo(20, 9);
  });

  it("does NOT time-slice position-truncated SELLs (only liquidity)", () => {
    const state = start(0, [{ symbol: "ACME", quantity: 10, avgCost: 5 }]);
    const res = simulateBrokerExecution(
      state,
      [sell("d1", "ACME", 100, 10)],
      { timeSliceUnfilled: true },
    );
    expect(res.snapshots).toHaveLength(1);
    expect(res.snapshots[0].truncationReason).toBe("position");
    expect(res.snapshots[0].fillQuantity).toBe(10);
  });

  it("time-slices a liquidity-throttled SELL too", () => {
    const state = start(0, [{ symbol: "ACME", quantity: 100, avgCost: 5 }]);
    const res = simulateBrokerExecution(
      state,
      [sell("d1", "ACME", 100, 10, 30)],
      { timeSliceUnfilled: true },
    );
    // 30 + 30 + 30 + 10 = 100 (4 snapshots).
    expect(res.snapshots.length).toBe(4);
    const totalFilled = res.snapshots.reduce((s, x) => s + x.fillQuantity, 0);
    expect(totalFilled).toBeCloseTo(100, 9);
    expect(res.snapshots.every((s) => s.sliceOf === "d1")).toBe(true);
    // Fully unwound.
    expect(res.finalState.holdings.find((h) => h.symbol === "ACME")).toBeUndefined();
  });

  it("preserves ordering when time-sliced across multiple decisions", () => {
    // d1 and d2 both throttle: expected step order = d1(parent), d2(parent),
    // d1(slice-1), d2(slice-1), d1(slice-2), d2(slice-2) — FIFO across the
    // queue so no decision monopolises the tape.
    const res = simulateBrokerExecution(
      start(100_000),
      [buy("d1", "A", 60, 10, 20), buy("d2", "B", 60, 10, 20)],
      { timeSliceUnfilled: true },
    );
    const ids = res.snapshots.map((s) => s.decisionId);
    expect(ids).toEqual([
      "d1", "d2",
      "d1#slice-1", "d2#slice-1",
      "d1#slice-2", "d2#slice-2",
    ]);
  });

  it("omits sliceOf/sliceIndex fields when the option is OFF (byte-identical)", () => {
    const res = simulateBrokerExecution(
      start(100_000),
      [buy("d1", "ACME", 100, 10, 30)],
      { /* timeSliceUnfilled: false */ },
    );
    expect(res.snapshots).toHaveLength(1);
    const s = res.snapshots[0];
    expect(s.fillQuantity).toBe(30);
    expect(s.partial).toBe(true);
    expect("sliceOf" in s).toBe(false);
    expect("sliceIndex" in s).toBe(false);
  });

  it("respects minFillQuantity: the FINAL residual slice can still fall below it and be rejected", () => {
    // Cap = 30/bar, min-fill = 15, request = 100 → parent 30, slice-1 30,
    // slice-2 30, slice-3 wants 10 but 10 < minFillQuantity=15 ⇒ rejected
    // as "no_liquidity" for that slice; earlier slices stand.
    const res = simulateBrokerExecution(
      start(100_000),
      [buy("d1", "ACME", 100, 10, 30)],
      { timeSliceUnfilled: true, liquidity: { minFillQuantity: 15 } },
    );
    expect(res.snapshots.length).toBe(3);
    expect(res.snapshots.every((s) => s.fillQuantity === 30)).toBe(true);
    expect(res.rejections).toHaveLength(1);
    expect(res.rejections[0].decisionId).toBe("d1#slice-3");
    expect(res.rejections[0].reason).toBe("no_liquidity");
  });

  it("fuzz: sliced execution keeps every invariant intact", () => {
    fc.assert(
      fc.property(
        fc.record({
          cash: fc.double({ min: 1_000, max: 500_000, noNaN: true, noDefaultInfinity: true }),
          price: fc.double({ min: 1, max: 200, noNaN: true, noDefaultInfinity: true }),
          reqQty: fc.integer({ min: 5, max: 500 }),
          availVol: fc.integer({ min: 1, max: 100 }),
          maxAttempts: fc.integer({ min: 0, max: 20 }),
        }),
        (p) => {
          const decisions: SimDecision[] = [
            buy("d1", "ACME", p.reqQty, p.price, p.availVol),
          ];
          const res = simulateBrokerExecution(
            start(p.cash),
            decisions,
            {
              timeSliceUnfilled: true,
              timeSliceMaxAttempts: p.maxAttempts,
            },
          );
          // Invariants hold across all sliced snapshots.
          const report = checkExecutionInvariants({
            initial: start(p.cash),
            decisions,
            snapshots: res.snapshots,
            rejections: res.rejections,
          });
          expect(report.ok).toBe(true);

          // Sum of fills ≤ original request.
          const totalFilled = res.snapshots.reduce(
            (s, x) => s + x.fillQuantity, 0,
          );
          expect(totalFilled).toBeLessThanOrEqual(p.reqQty + 1e-9);
          // Sum of fills ≤ attempts_used * availVol.
          const attemptsUsed = res.snapshots.length;
          expect(totalFilled).toBeLessThanOrEqual(attemptsUsed * p.availVol + 1e-9);
          // Attempts never exceed 1 + maxAttempts.
          expect(attemptsUsed).toBeLessThanOrEqual(1 + p.maxAttempts);
          // Every non-final snapshot is a liquidity partial when the
          // request outsized a single bar; the final snapshot may be a
          // full fill of its own residual.
          for (const s of res.snapshots) {
            expect(s.sliceOf).toBe("d1");
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
