// Fee-leg decomposition invariants.
//
// A fill's itemised legs (commission / exchange / stamp / fx / other) must
// reconstruct the charged fee EXACTLY in micro-units, and must independently
// explain the cash movement (±notional - Σ legs). These tests pin both, plus
// the negative controls for the ways this has historically gone wrong:
// a leg absorbed into the notional, a rebate-shaped sign flip, sub-penny
// rounding slack, and fees charged with no breakdown at all.

import { describe, expect, it } from "vitest";
import {
  assertLedgerReconciles,
  checkLedgerInvariants,
  sumFeeLegs,
  normaliseFeeLegs,
  type LedgerFill,
} from "../ledger-invariant-checker";

const buy = (over: Partial<LedgerFill> = {}): LedgerFill => ({
  id: "f1",
  symbol: "AAPL",
  side: "buy",
  quantity: 10,
  price: 100,
  fees: 8.5,
  feeLegs: { commission: 5, exchange: 0.5, stamp: 3 },
  ...over,
});

const codes = (fills: LedgerFill[], opts = {}) =>
  checkLedgerInvariants(fills, { startingCash: 10_000, ...opts }).violations.map((v) => v.code);

describe("fee-leg decomposition invariants", () => {
  it("accepts legs that sum exactly to the charged fee", () => {
    const res = assertLedgerReconciles([buy()], { startingCash: 10_000 });
    expect(res.ok).toBe(true);
    expect(res.steps[0].feeLegTotal).toBeCloseTo(8.5, 12);
    expect(res.steps[0].cashDelta).toBeCloseTo(-1008.5, 12);
  });

  it("sums legs in micro-units, zero-filling absent legs", () => {
    expect(sumFeeLegs(buy())).toBeCloseTo(8.5, 12);
    expect(normaliseFeeLegs(buy())).toEqual({
      commission: 5,
      exchange: 0.5,
      stamp: 3,
      fx: 0,
      other: 0,
    });
    expect(sumFeeLegs(buy({ feeLegs: undefined }))).toBeNull();
    expect(sumFeeLegs(buy({ feeLegs: {} }))).toBeNull();
  });

  it("flags legs that under-sum the charged fee (a leg lost into the notional)", () => {
    const v = codes([buy({ feeLegs: { commission: 5, exchange: 0.5 } })]);
    expect(v).toContain("fee_leg_sum_mismatch");
  });

  it("flags legs that over-sum the charged fee (double-booked commission)", () => {
    const v = codes([buy({ feeLegs: { commission: 10, exchange: 0.5, stamp: 3 } })]);
    expect(v).toContain("fee_leg_sum_mismatch");
  });

  it("rejects sub-penny rounding slack — the sum must be exact", () => {
    const v = codes([buy({ fees: 8.5, feeLegs: { commission: 5.000001, exchange: 0.5, stamp: 3 } })]);
    expect(v).toContain("fee_leg_sum_mismatch");
  });

  it("tolerates leg values below the micro-unit grid, which round to the same total", () => {
    const v = codes([
      buy({ fees: 8.5, feeLegs: { commission: 5.0000001, exchange: 0.4999999, stamp: 3 } }),
    ]);
    expect(v).not.toContain("fee_leg_sum_mismatch");
  });

  it("flags a negative leg by default and allows it when opted in", () => {
    const fill = buy({ fees: 2, feeLegs: { commission: 5, exchange: -3 } });
    expect(codes([fill])).toContain("negative_fee_leg");
    expect(codes([fill], { allowNegativeFeeLegs: true })).not.toContain("negative_fee_leg");
  });

  it("reports the offending leg name on a negative-leg violation", () => {
    const res = checkLedgerInvariants([buy({ fees: 2, feeLegs: { commission: 5, exchange: -3 } })], {
      startingCash: 10_000,
    });
    expect(res.violations.find((v) => v.code === "negative_fee_leg")?.leg).toBe("exchange");
  });

  it("flags non-finite legs before they poison the ledger", () => {
    const v = codes([buy({ feeLegs: { commission: Number.NaN, exchange: 0.5, stamp: 3 } })]);
    expect(v).toEqual(["invalid_fee_leg"]);
  });

  it("catches cash that ignores the legs even when fees were mis-stated to match", () => {
    // fees is consistent with the cash movement, but the legs say otherwise:
    // both the sum check and the leg-implied cash check must fire.
    const v = codes([buy({ fees: 0, feeLegs: { commission: 5, exchange: 0.5, stamp: 3 } })]);
    expect(v).toContain("fee_leg_sum_mismatch");
    expect(v).toContain("fee_leg_cash_mismatch");
  });

  it("requires a breakdown only when requireFeeLegs is set", () => {
    const bare = buy({ feeLegs: undefined });
    expect(codes([bare])).toEqual([]);
    expect(codes([bare], { requireFeeLegs: true })).toContain("missing_fee_legs");
    // A genuinely free fill needs no breakdown.
    expect(codes([buy({ fees: 0, feeLegs: undefined })], { requireFeeLegs: true })).toEqual([]);
  });

  it("holds across a sell leg where stamp duty is absent", () => {
    const fills: LedgerFill[] = [
      buy(),
      {
        id: "f2",
        symbol: "AAPL",
        side: "sell",
        quantity: 10,
        price: 110,
        fees: 5.75,
        feeLegs: { commission: 5, exchange: 0.5, fx: 0.25 },
      },
    ];
    const res = assertLedgerReconciles(fills, { startingCash: 10_000 });
    expect(res.ok).toBe(true);
    expect(res.finalCash).toBeCloseTo(10_000 - 1008.5 + 1100 - 5.75, 9);
  });

  it("accumulates fee legs consistently over many fills", () => {
    const fills: LedgerFill[] = Array.from({ length: 50 }, (_, i) => ({
      id: `f${i}`,
      symbol: i % 2 ? "VOD" : "AAPL",
      side: "buy",
      quantity: 1 + (i % 5),
      price: 12.34,
      fees: 3.21,
      feeLegs: { commission: 3, exchange: 0.11, stamp: 0.1 },
    }));
    const res = checkLedgerInvariants(fills, { startingCash: 100_000 });
    expect(res.ok).toBe(true);
    const totalLegs = res.steps.reduce((a, s) => a + (s.feeLegTotal ?? 0), 0);
    expect(totalLegs).toBeCloseTo(50 * 3.21, 6);
  });

  it("shrinks a fee-leg failure to the single offending fill", () => {
    const clean: LedgerFill[] = Array.from({ length: 12 }, (_, i) => buy({ id: `ok${i}` }));
    const bad = buy({ id: "BAD", feeLegs: { commission: 1 } });
    const res = checkLedgerInvariants([...clean.slice(0, 6), bad, ...clean.slice(6)], {
      startingCash: 1_000_000,
    });
    expect(res.ok).toBe(false);
    expect(res.smallestViolating.map((f) => f.id)).toEqual(["BAD"]);
    expect(res.report).toContain("fee_leg_sum_mismatch");
    expect(res.report).toContain("legs [");
  });

  it("assertLedgerReconciles throws with the leg breakdown in the message", () => {
    expect(() =>
      assertLedgerReconciles([buy({ feeLegs: { commission: 5 } })], { startingCash: 10_000 }, "ctx"),
    ).toThrow(/fee_leg_sum_mismatch|itemised/);
  });
});
