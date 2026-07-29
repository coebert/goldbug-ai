// End-to-end test: stale FX rates for JPY / AUD buys.
//
// `trimBuysToBudgetByCurrency` accepts two orthogonal FX hooks:
//   - `isRateStale(from, to)` → tags the emitted FxLeg with `stale: true`
//     so downstream audit / broker payload code can flag or reject the buy.
//   - `fxCostBps(from, to)` → inflates the base-ccy debit by
//     (1 + bps / 10_000) to reserve enough GBP for wallet spread + markup.
//
// This test locks the contract for both hooks against TSE (JPY) and ASX
// (AUD) buys, so:
//
//   1. A stale rate does NOT block the trim (still emits an `allow`
//      decision with an FX leg) but the leg is flagged `stale: true` for
//      the executor / audit to gate on.
//   2. FX cost bps inflate the base debit but do NOT change the native
//      credit / order notional.
//   3. Combining stale + fee inflation still nets a valid wallet, and
//      when the fee-inflated base need exceeds available GBP the trim
//      correctly skips with an `insufficient GBP` reason (rejection
//      behaviour).
//   4. Non-stale rates leave `stale: false` even when the same pair
//      appears elsewhere as stale.

import { describe, it, expect } from "vitest";
import {
  trimBuysToBudgetByCurrency,
  type FxResolver,
  type MultiCcyBudgetOrder,
} from "@/lib/pre-place-budget-multi-ccy";

const RATES: Record<string, number> = {
  GBPJPY: 190,
  GBPAUD: 1.9,
};
const fx: FxResolver = (from, to) =>
  from === to ? 1 : (RATES[`${from}${to}`] ?? null);

const jpyBuy = (): MultiCcyBudgetOrder => ({
  symbol: "7203.T",
  side: "buy",
  quantity: 100,
  price: 3_000,
  instrument_ccy: "JPY",
});
const audBuy = (): MultiCcyBudgetOrder => ({
  symbol: "BHP.AX",
  side: "buy",
  quantity: 50,
  price: 40,
  instrument_ccy: "AUD",
});

describe("Stale FX rate E2E: flags, fees, and rejection for JPY/AUD buys", () => {
  it("flags FX legs as stale without blocking the trim", () => {
    const result = trimBuysToBudgetByCurrency(
      [jpyBuy(), audBuy()],
      { GBP: 10_000 },
      "GBP",
      fx,
      {
        safetyBufferPct: 0,
        allowFxConversion: true,
        isRateStale: () => true, // both pairs stale
      },
    );

    expect(result.decisions.map((d) => d.kind)).toEqual(["allow", "allow"]);
    expect(result.fxLegs).toHaveLength(2);
    for (const leg of result.fxLegs) {
      expect(leg.stale).toBe(true);
    }
    // Notionals are unaffected by the staleness flag.
    const jpy = result.fxLegs.find((l) => l.toCcy === "JPY")!;
    const aud = result.fxLegs.find((l) => l.toCcy === "AUD")!;
    expect(jpy.amountTo).toBeCloseTo(300_000, 6);
    expect(aud.amountTo).toBeCloseTo(2_000, 6);
    expect(jpy.amountFrom).toBeCloseTo(300_000 / 190, 6);
    expect(aud.amountFrom).toBeCloseTo(2_000 / 1.9, 6);
  });

  it("only flags the pairs the resolver reports as stale", () => {
    // JPY stale, AUD fresh.
    const result = trimBuysToBudgetByCurrency(
      [jpyBuy(), audBuy()],
      { GBP: 10_000 },
      "GBP",
      fx,
      {
        safetyBufferPct: 0,
        isRateStale: (from, to) => from === "GBP" && to === "JPY",
      },
    );
    const jpy = result.fxLegs.find((l) => l.toCcy === "JPY")!;
    const aud = result.fxLegs.find((l) => l.toCcy === "AUD")!;
    expect(jpy.stale).toBe(true);
    expect(aud.stale).toBe(false);
  });

  it("inflates GBP debit by fxCostBps without changing native notional", () => {
    // 50 bps GBP→JPY, 80 bps GBP→AUD.
    const bpsByPair: Record<string, number> = { "GBP->JPY": 50, "GBP->AUD": 80 };
    const result = trimBuysToBudgetByCurrency(
      [jpyBuy(), audBuy()],
      { GBP: 10_000 },
      "GBP",
      fx,
      {
        safetyBufferPct: 0,
        fxCostBps: (from, to) => bpsByPair[`${from}->${to}`] ?? 0,
      },
    );

    expect(result.decisions.map((d) => d.kind)).toEqual(["allow", "allow"]);
    const jpy = result.fxLegs.find((l) => l.toCcy === "JPY")!;
    const aud = result.fxLegs.find((l) => l.toCcy === "AUD")!;

    // Native credit unchanged.
    expect(jpy.amountTo).toBeCloseTo(300_000, 6);
    expect(aud.amountTo).toBeCloseTo(2_000, 6);

    // Base debit inflated by (1 + bps/10_000).
    expect(jpy.amountFrom).toBeCloseTo((300_000 / 190) * 1.005, 6);
    expect(aud.amountFrom).toBeCloseTo((2_000 / 1.9) * 1.008, 6);

    // GBP wallet loses the *inflated* debits; JPY/AUD net to 0.
    const expectedGbp =
      10_000 - (300_000 / 190) * 1.005 - (2_000 / 1.9) * 1.008;
    expect(result.finalWallet.GBP).toBeCloseTo(expectedGbp, 6);
    expect(result.finalWallet.JPY).toBeCloseTo(0, 9);
    expect(result.finalWallet.AUD).toBeCloseTo(0, 9);
  });

  it("rejects the buy when stale-rate fee inflation exceeds available GBP", () => {
    // GBP wallet just above the un-inflated base need but below the
    // fee-inflated need. A wide 500 bps stress spread (simulating a stale
    // rate we distrust) should push it over.
    const baseNeed = 300_000 / 190; // ≈ £1,578.95
    const wallet = baseNeed + 1; // barely enough at par
    const result = trimBuysToBudgetByCurrency(
      [jpyBuy()],
      { GBP: wallet },
      "GBP",
      fx,
      {
        safetyBufferPct: 0,
        isRateStale: () => true,
        fxCostBps: () => 500, // 5% stress markup for stale pairs
      },
    );

    expect(result.decisions).toHaveLength(1);
    const d = result.decisions[0];
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") {
      expect(d.reason).toMatch(/insufficient JPY/);
      expect(d.reason).toMatch(/insufficient GBP to convert/);
    }
    // No leg executed → wallet untouched.
    expect(result.fxLegs).toHaveLength(0);
    expect(result.finalWallet.GBP).toBeCloseTo(wallet, 9);
    expect(result.finalWallet.JPY ?? 0).toBeCloseTo(0, 9);
  });

  it("with allowFxConversion=false, stale + fee hooks are irrelevant — skip on native cash", () => {
    // Executor policy: refuse cross-ccy conversion entirely (e.g. FX
    // circuit tripped). The buy must skip regardless of stale/fee hooks.
    const result = trimBuysToBudgetByCurrency(
      [jpyBuy(), audBuy()],
      { GBP: 1_000_000, JPY: 0, AUD: 0 },
      "GBP",
      fx,
      {
        safetyBufferPct: 0,
        allowFxConversion: false,
        isRateStale: () => true,
        fxCostBps: () => 200,
      },
    );
    expect(result.decisions.every((d) => d.kind === "skip")).toBe(true);
    expect(result.fxLegs).toHaveLength(0);
    for (const d of result.decisions) {
      if (d.kind === "skip") expect(d.reason).toMatch(/fx disabled/);
    }
    expect(result.finalWallet.GBP).toBe(1_000_000);
  });
});
