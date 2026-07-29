// End-to-end test: sample TSE (JPY) and ASX (AUD) orders.
//
// Composes the same wallet/FX pipeline the live executor runs
// (`trimBuysToBudgetByCurrency` from `pre-place-budget-multi-ccy`) with the
// venue settlement-date helper (`src/lib/settlement.ts`). Asserts, for a
// GBP-base portfolio placing one Toyota (7203.T, JPY) buy and one BHP
// (BHP.AX, AUD) buy:
//
//   1. Symbols are inferred to the correct instrument currency (JPY / AUD).
//   2. Each short-currency buy emits exactly one FX_LEG (GBP→JPY, GBP→AUD)
//      with the right amountFrom / amountTo / rate.
//   3. Equity settlement is T+2 for both venues; FX legs settle at or
//      before the equity leg so local-ccy cash has cleared on settle day.
//   4. Weekend/holiday roll-forward advances settlement past non-trading
//      days without changing notional.
//   5. Final wallet debits GBP for both FX legs and zeroes JPY/AUD after
//      the equity legs settle.
//
// Pure unit-style E2E — no Supabase, no Saxo HTTP client. If any of these
// contracts change, the wallet reconciler, FX audit log and settlement-
// date UI all need updating together.

import { describe, it, expect } from "vitest";
import {
  trimBuysToBudgetByCurrency,
  type FxResolver,
  type MultiCcyBudgetOrder,
} from "@/lib/pre-place-budget-multi-ccy";
import { inferSymbolCurrency } from "@/lib/ai-fx-conversions.server";
import { inferVenue } from "@/lib/market-hours";
import {
  settlementDate,
  fxSettlementDate,
  addBusinessDays,
} from "@/lib/settlement";

// GBP-base rates: 1 GBP = 190 JPY = 1.90 AUD (deliberately round for
// exact-arithmetic assertions).
const RATES: Record<string, number> = {
  GBPJPY: 190,
  JPYGBP: 1 / 190,
  GBPAUD: 1.9,
  AUDGBP: 1 / 1.9,
};
const fx: FxResolver = (from, to) =>
  from === to ? 1 : (RATES[`${from}${to}`] ?? null);

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe("TSE/ASX end-to-end: FX legs, settlement dates, cash balances", () => {
  it("routes Toyota (JPY) and BHP (AUD) buys with correct FX legs and final wallet", () => {
    // Sanity: symbols map to the right native currency + venue.
    expect(inferSymbolCurrency("7203.T", "GBP")).toBe("JPY");
    expect(inferSymbolCurrency("BHP.AX", "GBP")).toBe("AUD");
    expect(inferVenue("7203.T")).toBe("TSE_JP");
    expect(inferVenue("BHP.AX")).toBe("ASX");

    const buys: MultiCcyBudgetOrder[] = [
      // 100 shares × ¥3,000 = ¥300,000
      { symbol: "7203.T", side: "buy", quantity: 100, price: 3_000, instrument_ccy: "JPY" },
      // 50 shares × A$40 = A$2,000
      { symbol: "BHP.AX", side: "buy", quantity: 50, price: 40, instrument_ccy: "AUD" },
    ];

    // Wallet holds only GBP — both buys need an FX leg.
    const result = trimBuysToBudgetByCurrency(
      buys,
      { GBP: 10_000, JPY: 0, AUD: 0 },
      "GBP",
      fx,
      { safetyBufferPct: 0, allowFxConversion: true },
    );

    // Both allowed; no skips.
    expect(result.decisions.map((d) => d.kind)).toEqual(["allow", "allow"]);
    expect(result.skippedCount).toBe(0);

    // Exactly one FX leg per short currency, in placement order.
    expect(result.fxLegs).toHaveLength(2);
    const jpyLeg = result.fxLegs.find((l) => l.toCcy === "JPY");
    const audLeg = result.fxLegs.find((l) => l.toCcy === "AUD");
    expect(jpyLeg).toBeDefined();
    expect(audLeg).toBeDefined();

    // JPY leg funds the full ¥300,000 shortfall at 1 GBP = 190 JPY.
    expect(jpyLeg!.fromCcy).toBe("GBP");
    expect(jpyLeg!.triggeredBySymbol).toBe("7203.T");
    expect(jpyLeg!.amountTo).toBeCloseTo(300_000, 6);
    expect(jpyLeg!.amountFrom).toBeCloseTo(300_000 / 190, 6); // ~£1,578.95
    expect(jpyLeg!.amountFrom * jpyLeg!.rate).toBeCloseTo(jpyLeg!.amountTo, 6);
    expect(jpyLeg!.stale).toBe(false);

    // AUD leg funds A$2,000 at 1 GBP = 1.90 AUD.
    expect(audLeg!.fromCcy).toBe("GBP");
    expect(audLeg!.triggeredBySymbol).toBe("BHP.AX");
    expect(audLeg!.amountTo).toBeCloseTo(2_000, 6);
    expect(audLeg!.amountFrom).toBeCloseTo(2_000 / 1.9, 6); // ~£1,052.63
    expect(audLeg!.amountFrom * audLeg!.rate).toBeCloseTo(audLeg!.amountTo, 6);

    // Final wallet:
    //   GBP: 10,000 − (¥300k / 190) − (A$2k / 1.9)
    //   JPY: +300k − 300k = 0
    //   AUD: +2k   − 2k   = 0
    const expectedGbp = 10_000 - 300_000 / 190 - 2_000 / 1.9;
    expect(result.finalWallet.GBP).toBeCloseTo(expectedGbp, 6);
    expect(result.finalWallet.JPY).toBeCloseTo(0, 9);
    expect(result.finalWallet.AUD).toBeCloseTo(0, 9);
  });

  it("assigns T+2 settlement for TSE and ASX and lands FX at or before equity settle", () => {
    // Trade on Monday 2026-03-02 — no holidays, plain business-day walk.
    const tradeDate = new Date(Date.UTC(2026, 2, 2)); // Mon
    expect(tradeDate.getUTCDay()).toBe(1);

    const tseSettle = settlementDate(tradeDate, "TSE_JP");
    const asxSettle = settlementDate(tradeDate, "ASX");
    // T+2 business days = Wed 2026-03-04.
    expect(ymd(tseSettle)).toBe("2026-03-04");
    expect(ymd(asxSettle)).toBe("2026-03-04");

    // FX spot for GBP/JPY and GBP/AUD is T+2 — same day as equity settle.
    const jpyFxSettle = fxSettlementDate(tradeDate, "GBP", "JPY");
    const audFxSettle = fxSettlementDate(tradeDate, "GBP", "AUD");
    expect(ymd(jpyFxSettle)).toBe("2026-03-04");
    expect(ymd(audFxSettle)).toBe("2026-03-04");

    // The wallet-safety invariant: FX must clear no later than equity.
    expect(jpyFxSettle.getTime()).toBeLessThanOrEqual(tseSettle.getTime());
    expect(audFxSettle.getTime()).toBeLessThanOrEqual(asxSettle.getTime());
  });

  it("rolls settlement past weekends and venue holidays without changing notional", () => {
    // Trade Thursday 2026-03-05. T+2 with no holidays = Mon 2026-03-09
    // (Fri counts as +1, weekend skipped, Mon = +2).
    const tradeDate = new Date(Date.UTC(2026, 2, 5)); // Thu
    expect(tradeDate.getUTCDay()).toBe(4);
    expect(ymd(settlementDate(tradeDate, "TSE_JP"))).toBe("2026-03-09");
    expect(ymd(settlementDate(tradeDate, "ASX"))).toBe("2026-03-09");

    // Add a venue holiday on Fri 2026-03-06 → settlement rolls one more
    // business day to Tue 2026-03-10. Notional/FX rate are unaffected.
    const tseHolidays = new Set<string>(["2026-03-06"]);
    const asxHolidays = new Set<string>(["2026-03-06"]);
    expect(ymd(settlementDate(tradeDate, "TSE_JP", tseHolidays))).toBe("2026-03-10");
    expect(ymd(settlementDate(tradeDate, "ASX", asxHolidays))).toBe("2026-03-10");

    // addBusinessDays never lands on a weekend.
    for (let n = 1; n <= 10; n += 1) {
      const d = addBusinessDays(tradeDate, n);
      const dow = d.getUTCDay();
      expect(dow).not.toBe(0);
      expect(dow).not.toBe(6);
    }

    // Re-running the wallet trim with the same buys produces identical FX
    // notionals regardless of settlement date — settle is a *when*, not a
    // *how much*.
    const buys: MultiCcyBudgetOrder[] = [
      { symbol: "7203.T", side: "buy", quantity: 100, price: 3_000, instrument_ccy: "JPY" },
      { symbol: "BHP.AX", side: "buy", quantity: 50, price: 40, instrument_ccy: "AUD" },
    ];
    const trim = trimBuysToBudgetByCurrency(
      buys,
      { GBP: 10_000 },
      "GBP",
      fx,
      { safetyBufferPct: 0, allowFxConversion: true },
    );
    const jpy = trim.fxLegs.find((l) => l.toCcy === "JPY")!;
    const aud = trim.fxLegs.find((l) => l.toCcy === "AUD")!;
    expect(jpy.amountTo).toBeCloseTo(300_000, 6);
    expect(aud.amountTo).toBeCloseTo(2_000, 6);
  });

  it("uses existing native-ccy cash first, only FX-converting the shortfall", () => {
    // Wallet already has ¥100,000 and A$500 — trimmer should only FX-fund
    // the remaining ¥200,000 and A$1,500.
    const buys: MultiCcyBudgetOrder[] = [
      { symbol: "7203.T", side: "buy", quantity: 100, price: 3_000, instrument_ccy: "JPY" },
      { symbol: "BHP.AX", side: "buy", quantity: 50, price: 40, instrument_ccy: "AUD" },
    ];
    const result = trimBuysToBudgetByCurrency(
      buys,
      { GBP: 5_000, JPY: 100_000, AUD: 500 },
      "GBP",
      fx,
      { safetyBufferPct: 0, allowFxConversion: true },
    );
    expect(result.decisions.map((d) => d.kind)).toEqual(["allow", "allow"]);

    const jpy = result.fxLegs.find((l) => l.toCcy === "JPY")!;
    const aud = result.fxLegs.find((l) => l.toCcy === "AUD")!;
    expect(jpy.amountTo).toBeCloseTo(200_000, 6); // shortfall only
    expect(aud.amountTo).toBeCloseTo(1_500, 6);
    expect(jpy.amountFrom).toBeCloseTo(200_000 / 190, 6);
    expect(aud.amountFrom).toBeCloseTo(1_500 / 1.9, 6);

    // Final: GBP debits both FX legs; JPY/AUD net to zero after equity.
    const expectedGbp = 5_000 - 200_000 / 190 - 1_500 / 1.9;
    expect(result.finalWallet.GBP).toBeCloseTo(expectedGbp, 6);
    expect(result.finalWallet.JPY).toBeCloseTo(0, 9);
    expect(result.finalWallet.AUD).toBeCloseTo(0, 9);
  });

  it("skips the buy when base wallet cannot fund the FX (no borrowing)", () => {
    // Only £100 available — nowhere near enough for either FX leg.
    const buys: MultiCcyBudgetOrder[] = [
      { symbol: "7203.T", side: "buy", quantity: 100, price: 3_000, instrument_ccy: "JPY" },
      { symbol: "BHP.AX", side: "buy", quantity: 50, price: 40, instrument_ccy: "AUD" },
    ];
    const result = trimBuysToBudgetByCurrency(
      buys,
      { GBP: 100 },
      "GBP",
      fx,
      { safetyBufferPct: 0, allowFxConversion: true },
    );
    expect(result.decisions.every((d) => d.kind === "skip")).toBe(true);
    expect(result.fxLegs).toHaveLength(0);
    expect(result.finalWallet.GBP).toBe(100);
    for (const d of result.decisions) {
      if (d.kind === "skip") expect(d.reason).toMatch(/insufficient GBP to convert/);
    }
  });
});
