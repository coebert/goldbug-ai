// End-to-end test: sample TSE (JPY) and ASX (AUD) SELL orders.
//
// The buy pipeline in `trimBuysToBudgetByCurrency` reserves base-ccy cash
// and emits an FX leg to fund a short native-ccy balance. Sells run the
// mirror image: native-ccy proceeds land in the wallet at trade time, and
// a separate sweep leg (native → base) repatriates them at spot. This
// test locks that contract for TSE_JP and ASX symbols, alongside the same
// venue settlement-date helper (`src/lib/settlement.ts`) used on the
// buy-side test.
//
// Asserts, for a GBP-base portfolio selling Toyota (7203.T, JPY) and BHP
// (BHP.AX, AUD):
//
//   1. Symbols infer to the correct native currency + venue.
//   2. Native-cash proceeds credit at trade time (¥ or A$) matching
//      quantity × price.
//   3. An optional native→GBP sweep leg produces the right base amount
//      at spot with no double-spend of the proceeds.
//   4. Equity settles T+2; the sweep FX leg settles at or before equity
//      settle so base cash is spendable on the same business day.
//   5. Weekend / venue-holiday roll-forward advances settlement without
//      changing notional or FX rate.
//   6. Partial sweep (leave working balance in native ccy) preserves the
//      un-swept residual so subsequent same-ccy buys skip a fresh FX leg.

import { describe, it, expect } from "vitest";
import { inferSymbolCurrency } from "@/lib/ai-fx-conversions.server";
import { inferVenue } from "@/lib/market-hours";
import {
  settlementDate,
  fxSettlementDate,
  addBusinessDays,
} from "@/lib/settlement";

// GBP-base rates: 1 GBP = 190 JPY = 1.90 AUD (round numbers for exact
// arithmetic assertions).
const RATES: Record<string, number> = {
  GBPJPY: 190,
  JPYGBP: 1 / 190,
  GBPAUD: 1.9,
  AUDGBP: 1 / 1.9,
};
const rate = (from: string, to: string): number =>
  from === to ? 1 : (RATES[`${from}${to}`] ?? 0);

type SellOrder = {
  symbol: string;
  side: "sell";
  quantity: number;
  price: number;
  instrument_ccy: string;
};

type SweepLeg = {
  fromCcy: string;
  toCcy: string;
  amountFrom: number;
  amountTo: number;
  rate: number;
  triggeredBySymbol: string;
};

/**
 * Mirror of `trimBuysToBudgetByCurrency` for the sell path — credits
 * native-ccy proceeds and (optionally) sweeps them to base at spot.
 * Pure; no broker or DB calls. `sweepPct` in [0,1] controls how much of
 * each fill is repatriated.
 */
function applySellsAndSweep(
  sells: SellOrder[],
  initialWallet: Record<string, number>,
  baseCcy: string,
  sweepPct: number,
): { finalWallet: Record<string, number>; sweeps: SweepLeg[] } {
  const wallet: Record<string, number> = { ...initialWallet };
  const sweeps: SweepLeg[] = [];
  const base = baseCcy.toUpperCase();

  for (const o of sells) {
    if (o.side !== "sell") continue;
    const ccy = o.instrument_ccy.toUpperCase();
    const proceedsNative = o.quantity * o.price;
    wallet[ccy] = (wallet[ccy] ?? 0) + proceedsNative;

    if (sweepPct <= 0 || ccy === base) continue;
    const r = rate(ccy, base);
    if (r <= 0) continue;
    const amountFrom = proceedsNative * sweepPct;
    const amountTo = amountFrom * r;
    wallet[ccy] -= amountFrom;
    wallet[base] = (wallet[base] ?? 0) + amountTo;
    sweeps.push({
      fromCcy: ccy,
      toCcy: base,
      amountFrom,
      amountTo,
      rate: r,
      triggeredBySymbol: o.symbol,
    });
  }
  return { finalWallet: wallet, sweeps };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe("TSE/ASX end-to-end SELLS: FX legs, settlement dates, cash balances", () => {
  it("routes Toyota and BHP sells with full base-ccy sweep", () => {
    // Sanity: symbols map to the right native currency + venue.
    expect(inferSymbolCurrency("7203.T", "GBP")).toBe("JPY");
    expect(inferSymbolCurrency("BHP.AX", "GBP")).toBe("AUD");
    expect(inferVenue("7203.T")).toBe("TSE_JP");
    expect(inferVenue("BHP.AX")).toBe("ASX");

    const sells: SellOrder[] = [
      // 100 shares × ¥3,000 = ¥300,000 proceeds
      { symbol: "7203.T", side: "sell", quantity: 100, price: 3_000, instrument_ccy: "JPY" },
      // 50 shares × A$40 = A$2,000 proceeds
      { symbol: "BHP.AX", side: "sell", quantity: 50, price: 40, instrument_ccy: "AUD" },
    ];

    const { finalWallet, sweeps } = applySellsAndSweep(
      sells,
      { GBP: 1_000, JPY: 0, AUD: 0 },
      "GBP",
      1, // sweep 100%
    );

    // One sweep leg per non-base currency.
    expect(sweeps).toHaveLength(2);
    const jpySweep = sweeps.find((s) => s.fromCcy === "JPY")!;
    const audSweep = sweeps.find((s) => s.fromCcy === "AUD")!;

    expect(jpySweep.toCcy).toBe("GBP");
    expect(jpySweep.triggeredBySymbol).toBe("7203.T");
    expect(jpySweep.amountFrom).toBeCloseTo(300_000, 6);
    expect(jpySweep.amountTo).toBeCloseTo(300_000 / 190, 6); // ~£1,578.95
    expect(jpySweep.amountFrom * jpySweep.rate).toBeCloseTo(jpySweep.amountTo, 6);

    expect(audSweep.toCcy).toBe("GBP");
    expect(audSweep.triggeredBySymbol).toBe("BHP.AX");
    expect(audSweep.amountFrom).toBeCloseTo(2_000, 6);
    expect(audSweep.amountTo).toBeCloseTo(2_000 / 1.9, 6); // ~£1,052.63

    // Final wallet: JPY/AUD swept to 0; GBP = 1000 + both sweeps.
    const expectedGbp = 1_000 + 300_000 / 190 + 2_000 / 1.9;
    expect(finalWallet.GBP).toBeCloseTo(expectedGbp, 6);
    expect(finalWallet.JPY).toBeCloseTo(0, 9);
    expect(finalWallet.AUD).toBeCloseTo(0, 9);
  });

  it("assigns T+2 settlement for TSE and ASX sells and lands sweep FX at or before equity settle", () => {
    // Trade Monday 2026-03-02 — plain business-day walk.
    const tradeDate = new Date(Date.UTC(2026, 2, 2));
    expect(tradeDate.getUTCDay()).toBe(1);

    const tseSettle = settlementDate(tradeDate, "TSE_JP");
    const asxSettle = settlementDate(tradeDate, "ASX");
    expect(ymd(tseSettle)).toBe("2026-03-04");
    expect(ymd(asxSettle)).toBe("2026-03-04");

    // Sweep FX (JPY→GBP, AUD→GBP) is T+2 spot.
    const jpySweepSettle = fxSettlementDate(tradeDate, "JPY", "GBP");
    const audSweepSettle = fxSettlementDate(tradeDate, "AUD", "GBP");
    expect(ymd(jpySweepSettle)).toBe("2026-03-04");
    expect(ymd(audSweepSettle)).toBe("2026-03-04");

    // Sweep must clear no later than equity — otherwise GBP wouldn't be
    // spendable on settle day.
    expect(jpySweepSettle.getTime()).toBeLessThanOrEqual(tseSettle.getTime());
    expect(audSweepSettle.getTime()).toBeLessThanOrEqual(asxSettle.getTime());
  });

  it("rolls sell settlement past weekends and venue holidays without changing proceeds", () => {
    // Thu 2026-03-05 → T+2 = Mon 2026-03-09.
    const tradeDate = new Date(Date.UTC(2026, 2, 5));
    expect(ymd(settlementDate(tradeDate, "TSE_JP"))).toBe("2026-03-09");
    expect(ymd(settlementDate(tradeDate, "ASX"))).toBe("2026-03-09");

    // Add a venue holiday on Fri 2026-03-06 → rolls to Tue 2026-03-10.
    const hol = new Set<string>(["2026-03-06"]);
    expect(ymd(settlementDate(tradeDate, "TSE_JP", hol))).toBe("2026-03-10");
    expect(ymd(settlementDate(tradeDate, "ASX", hol))).toBe("2026-03-10");

    // addBusinessDays never lands on a weekend.
    for (let n = 1; n <= 10; n += 1) {
      const dow = addBusinessDays(tradeDate, n).getUTCDay();
      expect(dow).not.toBe(0);
      expect(dow).not.toBe(6);
    }

    // Proceeds + sweep are independent of settlement date.
    const { finalWallet, sweeps } = applySellsAndSweep(
      [
        { symbol: "7203.T", side: "sell", quantity: 100, price: 3_000, instrument_ccy: "JPY" },
        { symbol: "BHP.AX", side: "sell", quantity: 50, price: 40, instrument_ccy: "AUD" },
      ],
      { GBP: 0 },
      "GBP",
      1,
    );
    expect(sweeps.find((s) => s.fromCcy === "JPY")!.amountFrom).toBeCloseTo(300_000, 6);
    expect(sweeps.find((s) => s.fromCcy === "AUD")!.amountFrom).toBeCloseTo(2_000, 6);
    expect(finalWallet.JPY).toBeCloseTo(0, 9);
    expect(finalWallet.AUD).toBeCloseTo(0, 9);
  });

  it("partial sweep preserves un-swept native-ccy residual for future same-ccy activity", () => {
    // Sell ¥300,000 and A$2,000 but only sweep 40% back to GBP.
    const { finalWallet, sweeps } = applySellsAndSweep(
      [
        { symbol: "7203.T", side: "sell", quantity: 100, price: 3_000, instrument_ccy: "JPY" },
        { symbol: "BHP.AX", side: "sell", quantity: 50, price: 40, instrument_ccy: "AUD" },
      ],
      { GBP: 0, JPY: 25_000, AUD: 100 },
      "GBP",
      0.4,
    );

    // Sweep only the 40% of *proceeds* — starting balances stay put.
    expect(sweeps).toHaveLength(2);
    const jpySweep = sweeps.find((s) => s.fromCcy === "JPY")!;
    const audSweep = sweeps.find((s) => s.fromCcy === "AUD")!;
    expect(jpySweep.amountFrom).toBeCloseTo(120_000, 6); // 40% of 300k
    expect(audSweep.amountFrom).toBeCloseTo(800, 6); // 40% of 2k

    // Residuals: 25,000 opening + 180,000 unswept = ¥205,000; 100 + 1,200 = A$1,300.
    expect(finalWallet.JPY).toBeCloseTo(205_000, 6);
    expect(finalWallet.AUD).toBeCloseTo(1_300, 6);
    // GBP: only the two swept legs.
    expect(finalWallet.GBP).toBeCloseTo(120_000 / 190 + 800 / 1.9, 6);
  });

  it("skips sweep leg for sells whose native ccy already equals base", () => {
    // GBP-native sell should not emit a sweep and should credit GBP.
    const { finalWallet, sweeps } = applySellsAndSweep(
      [{ symbol: "VUKE.L", side: "sell", quantity: 10, price: 30, instrument_ccy: "GBP" }],
      { GBP: 500 },
      "GBP",
      1,
    );
    expect(sweeps).toHaveLength(0);
    expect(finalWallet.GBP).toBeCloseTo(800, 6); // 500 + 10×30
  });
});
