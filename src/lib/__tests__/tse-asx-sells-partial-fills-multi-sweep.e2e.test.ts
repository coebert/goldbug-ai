// End-to-end test: multi-sweep PARTIAL FILLS on TSE/ASX sells.
//
// When a sell order fills in multiple slices, each fill credits native-ccy
// proceeds independently and (under the standard auto-sweep policy) emits
// its own base-ccy sweep leg. This test locks the invariants that keep the
// wallet consistent under those repeated small settlements:
//
//   1. Per-fill sweep legs are emitted in fill order with amounts equal
//      to that fill's proceeds × sweepPct at the fill-time FX rate.
//   2. Rate drift across fills is honoured leg-by-leg — the base credit
//      reflects the rate at each fill, not a blended average.
//   3. Native-ccy residual after a partial sweep (sweepPct < 1) stays in
//      the wallet and does NOT double-sweep on later fills.
//   4. Every fill's FX spot leg settles T+2, at or before the T+2 equity
//      settle for the parent order, so base cash is spendable on the
//      final settle day of the last slice.
//   5. Sum of per-leg base credits equals sweepPct × sum(fill notional ×
//      fill rate); JPY / AUD nets to (1 − sweepPct) × totalNativeProceeds.

import { describe, it, expect } from "vitest";
import { inferSymbolCurrency } from "@/lib/ai-fx-conversions.server";
import { inferVenue } from "@/lib/market-hours";
import { settlementDate, fxSettlementDate, addBusinessDays } from "@/lib/settlement";

// -------- Pure per-fill sweep simulator (mirror of live executor policy) --------

type PartialFill = {
  /** ISO date string of the fill (used to settle FX at T+2 from fill date). */
  filledOn: Date;
  quantity: number;
  /** Fill price in native currency (may differ per slice). */
  price: number;
  /** Mid FX rate native→base captured at fill time. */
  fxRateNativeToBase: number;
};

type SellSlicePlan = {
  symbol: string;
  instrument_ccy: string;
  fills: PartialFill[];
};

type SweepLeg = {
  fromCcy: string;
  toCcy: string;
  amountFrom: number;
  amountTo: number;
  rate: number;
  triggeredBySymbol: string;
  triggeredByFillIndex: number;
  fxSettle: Date;
};

function simulateSlicedSellsWithSweep(
  orders: SellSlicePlan[],
  initialWallet: Record<string, number>,
  baseCcy: string,
  sweepPct: number,
): { wallet: Record<string, number>; sweeps: SweepLeg[] } {
  const wallet: Record<string, number> = { ...initialWallet };
  const sweeps: SweepLeg[] = [];
  const base = baseCcy.toUpperCase();

  for (const o of orders) {
    const ccy = o.instrument_ccy.toUpperCase();
    o.fills.forEach((f, idx) => {
      const proceedsNative = f.quantity * f.price;
      // Credit native proceeds.
      wallet[ccy] = (wallet[ccy] ?? 0) + proceedsNative;
      if (sweepPct <= 0 || ccy === base) return;
      const amountFrom = proceedsNative * sweepPct;
      const amountTo = amountFrom * f.fxRateNativeToBase;
      wallet[ccy] -= amountFrom;
      wallet[base] = (wallet[base] ?? 0) + amountTo;
      sweeps.push({
        fromCcy: ccy,
        toCcy: base,
        amountFrom,
        amountTo,
        rate: f.fxRateNativeToBase,
        triggeredBySymbol: o.symbol,
        triggeredByFillIndex: idx,
        fxSettle: fxSettlementDate(f.filledOn, ccy, base),
      });
    });
  }
  return { wallet, sweeps };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

describe("Multi-sweep partial fills on TSE/ASX sells", () => {
  it("emits one sweep leg per fill, in fill order, at fill-time rate", () => {
    // Sanity: symbols map correctly.
    expect(inferSymbolCurrency("7203.T", "GBP")).toBe("JPY");
    expect(inferSymbolCurrency("BHP.AX", "GBP")).toBe("AUD");
    expect(inferVenue("7203.T")).toBe("TSE_JP");
    expect(inferVenue("BHP.AX")).toBe("ASX");

    // Toyota sell fills 3× across the day; JPY→GBP rate drifts.
    // Rates in JPY/GBP: 190, 191, 189 (i.e. 1 JPY = 1/190, 1/191, 1/189 GBP)
    const toyota: SellSlicePlan = {
      symbol: "7203.T",
      instrument_ccy: "JPY",
      fills: [
        { filledOn: new Date(Date.UTC(2026, 2, 2)), quantity: 40, price: 3_000, fxRateNativeToBase: 1 / 190 },
        { filledOn: new Date(Date.UTC(2026, 2, 2)), quantity: 30, price: 3_020, fxRateNativeToBase: 1 / 191 },
        { filledOn: new Date(Date.UTC(2026, 2, 2)), quantity: 30, price: 3_010, fxRateNativeToBase: 1 / 189 },
      ],
    };

    const { wallet, sweeps } = simulateSlicedSellsWithSweep(
      [toyota],
      { GBP: 0, JPY: 0 },
      "GBP",
      1, // sweep 100%
    );

    expect(sweeps).toHaveLength(3);
    expect(sweeps.map((s) => s.triggeredByFillIndex)).toEqual([0, 1, 2]);
    for (const s of sweeps) {
      expect(s.fromCcy).toBe("JPY");
      expect(s.toCcy).toBe("GBP");
      expect(s.triggeredBySymbol).toBe("7203.T");
    }

    // Each leg's base amount uses the fill-time rate, not a blended one.
    const proceeds = [40 * 3_000, 30 * 3_020, 30 * 3_010];
    const rates = [1 / 190, 1 / 191, 1 / 189];
    sweeps.forEach((s, i) => {
      expect(s.amountFrom).toBeCloseTo(proceeds[i], 6);
      expect(s.amountTo).toBeCloseTo(proceeds[i] * rates[i], 9);
      expect(s.rate).toBe(rates[i]);
    });

    // JPY fully swept → 0. GBP = sum of amountTo.
    const expectedGbp = proceeds.reduce((sum, p, i) => sum + p * rates[i], 0);
    expect(wallet.GBP).toBeCloseTo(expectedGbp, 9);
    expect(wallet.JPY).toBeCloseTo(0, 9);
  });

  it("partial sweep (60%) leaves residual native cash without double-sweeping", () => {
    // BHP sell fills 2× at drifting AUD/GBP rates. Sweep only 60% each fill.
    const bhp: SellSlicePlan = {
      symbol: "BHP.AX",
      instrument_ccy: "AUD",
      fills: [
        { filledOn: new Date(Date.UTC(2026, 2, 2)), quantity: 30, price: 40, fxRateNativeToBase: 1 / 1.9 },
        { filledOn: new Date(Date.UTC(2026, 2, 2)), quantity: 20, price: 41, fxRateNativeToBase: 1 / 1.92 },
      ],
    };

    const { wallet, sweeps } = simulateSlicedSellsWithSweep(
      [bhp],
      { GBP: 100, AUD: 250 }, // opening AUD balance untouched by sweeps
      "GBP",
      0.6,
    );

    expect(sweeps).toHaveLength(2);
    const proceeds = [30 * 40, 20 * 41]; // 1200, 820
    const rates = [1 / 1.9, 1 / 1.92];
    sweeps.forEach((s, i) => {
      expect(s.amountFrom).toBeCloseTo(proceeds[i] * 0.6, 6); // 720, 492
      expect(s.amountTo).toBeCloseTo(proceeds[i] * 0.6 * rates[i], 9);
    });

    // Residual AUD = opening 250 + 40% of each fill's proceeds.
    const residualAud = 250 + proceeds.reduce((sum, p) => sum + p * 0.4, 0); // 250 + 480 + 328
    expect(wallet.AUD).toBeCloseTo(residualAud, 6);

    // GBP = opening 100 + sum of amountTo.
    const gbpFromSweeps = sweeps.reduce((sum, s) => sum + s.amountTo, 0);
    expect(wallet.GBP).toBeCloseTo(100 + gbpFromSweeps, 9);
  });

  it("mixed TSE + ASX sliced sells reconcile per-leg amounts and totals", () => {
    const orders: SellSlicePlan[] = [
      {
        symbol: "7203.T",
        instrument_ccy: "JPY",
        fills: [
          { filledOn: new Date(Date.UTC(2026, 2, 2)), quantity: 50, price: 3_000, fxRateNativeToBase: 1 / 190 },
          { filledOn: new Date(Date.UTC(2026, 2, 2)), quantity: 50, price: 3_010, fxRateNativeToBase: 1 / 190 },
        ],
      },
      {
        symbol: "BHP.AX",
        instrument_ccy: "AUD",
        fills: [
          { filledOn: new Date(Date.UTC(2026, 2, 2)), quantity: 25, price: 40, fxRateNativeToBase: 1 / 1.9 },
          { filledOn: new Date(Date.UTC(2026, 2, 2)), quantity: 25, price: 40, fxRateNativeToBase: 1 / 1.9 },
        ],
      },
    ];
    const { wallet, sweeps } = simulateSlicedSellsWithSweep(
      orders,
      { GBP: 0 },
      "GBP",
      1,
    );

    // 4 sweeps total: two per symbol, grouped by order.
    expect(sweeps).toHaveLength(4);
    expect(sweeps.map((s) => s.triggeredBySymbol)).toEqual([
      "7203.T",
      "7203.T",
      "BHP.AX",
      "BHP.AX",
    ]);

    const totalJpyProceeds = 50 * 3_000 + 50 * 3_010;
    const totalAudProceeds = 25 * 40 + 25 * 40;

    // JPY / AUD fully swept → 0.
    expect(wallet.JPY).toBeCloseTo(0, 9);
    expect(wallet.AUD).toBeCloseTo(0, 9);

    // GBP total = JPY total / 190 + AUD total / 1.9.
    const expectedGbp = totalJpyProceeds / 190 + totalAudProceeds / 1.9;
    expect(wallet.GBP).toBeCloseTo(expectedGbp, 6);
    const gbpFromSweeps = sweeps.reduce((sum, s) => sum + s.amountTo, 0);
    expect(gbpFromSweeps).toBeCloseTo(expectedGbp, 6);
  });

  it("each FX sweep leg settles at or before the parent equity settle (T+2)", () => {
    // All fills on Mon 2026-03-02 → parent equity settle 2026-03-04.
    const tradeDate = new Date(Date.UTC(2026, 2, 2));
    const parentTse = settlementDate(tradeDate, "TSE_JP");
    const parentAsx = settlementDate(tradeDate, "ASX");
    expect(ymd(parentTse)).toBe("2026-03-04");
    expect(ymd(parentAsx)).toBe("2026-03-04");

    const orders: SellSlicePlan[] = [
      {
        symbol: "7203.T",
        instrument_ccy: "JPY",
        fills: [0, 1, 2].map(() => ({
          filledOn: tradeDate,
          quantity: 30,
          price: 3_000,
          fxRateNativeToBase: 1 / 190,
        })),
      },
      {
        symbol: "BHP.AX",
        instrument_ccy: "AUD",
        fills: [0, 1].map(() => ({
          filledOn: tradeDate,
          quantity: 25,
          price: 40,
          fxRateNativeToBase: 1 / 1.9,
        })),
      },
    ];
    const { sweeps } = simulateSlicedSellsWithSweep(orders, { GBP: 0 }, "GBP", 1);
    expect(sweeps).toHaveLength(5);

    for (const s of sweeps) {
      const parent = s.fromCcy === "JPY" ? parentTse : parentAsx;
      // FX spot for JPY→GBP and AUD→GBP is T+2 → same day as equity settle.
      expect(ymd(s.fxSettle)).toBe(ymd(parent));
      expect(s.fxSettle.getTime()).toBeLessThanOrEqual(parent.getTime());
    }
  });

  it("fills spread across days roll settlement per fill date, weekends skipped", () => {
    // Slice 1 on Thu 2026-03-05, slice 2 on Fri 2026-03-06.
    // T+2 from Thu = Mon 2026-03-09; T+2 from Fri = Tue 2026-03-10.
    const thu = new Date(Date.UTC(2026, 2, 5));
    const fri = new Date(Date.UTC(2026, 2, 6));
    expect(thu.getUTCDay()).toBe(4);
    expect(fri.getUTCDay()).toBe(5);

    const order: SellSlicePlan = {
      symbol: "BHP.AX",
      instrument_ccy: "AUD",
      fills: [
        { filledOn: thu, quantity: 25, price: 40, fxRateNativeToBase: 1 / 1.9 },
        { filledOn: fri, quantity: 25, price: 40, fxRateNativeToBase: 1 / 1.9 },
      ],
    };
    const { sweeps } = simulateSlicedSellsWithSweep([order], { GBP: 0 }, "GBP", 1);
    expect(sweeps).toHaveLength(2);
    expect(ymd(sweeps[0].fxSettle)).toBe("2026-03-09");
    expect(ymd(sweeps[1].fxSettle)).toBe("2026-03-10");

    // Sanity: addBusinessDays never lands on a weekend regardless of start.
    for (const start of [thu, fri]) {
      for (let n = 1; n <= 5; n += 1) {
        const dow = addBusinessDays(start, n).getUTCDay();
        expect(dow).not.toBe(0);
        expect(dow).not.toBe(6);
      }
    }
  });
});
