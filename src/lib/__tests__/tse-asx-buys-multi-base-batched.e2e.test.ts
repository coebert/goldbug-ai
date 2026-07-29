// End-to-end test: TSE/ASX BUY orders across additional base currencies
// and multi-symbol batches. Complements
// `tse-asx-orders-fx-settlement.e2e.test.ts` (GBP base, one symbol per
// venue) by covering:
//
//   1. USD-base account buying TSE (JPY) via USD → JPY FX leg.
//   2. EUR-base account buying ASX (AUD) via EUR → AUD FX leg.
//   3. Batched buys on the same venue collapse funding into per-symbol
//      FX legs whose native amounts sum to the total needed and whose
//      base amounts sum to the total base debited.
//   4. Equity settlement (T+2 at TSE/ASX) matches the FX spot leg
//      settlement, so native cash clears in time regardless of the
//      base currency.
//   5. Final wallet reconciles: base debited exactly by the sum of FX
//      legs' amountFrom; JPY / AUD nets to zero after equity settle.

import { describe, it, expect } from "vitest";
import {
  trimBuysToBudgetByCurrency,
  type FxResolver,
  type MultiCcyBudgetOrder,
} from "@/lib/pre-place-budget-multi-ccy";
import { inferSymbolCurrency } from "@/lib/ai-fx-conversions.server";
import { inferVenue } from "@/lib/market-hours";
import { settlementDate, fxSettlementDate } from "@/lib/settlement";

// Rounded mids for exact arithmetic.
const MID: Record<string, number> = {
  USDJPY: 150, // 1 USD = 150 JPY
  EURAUD: 1.6, // 1 EUR = 1.60 AUD
};
const fx: FxResolver = (from, to) =>
  from === to ? 1 : (MID[`${from}${to}`] ?? null);

const ymd = (d: Date) => d.toISOString().slice(0, 10);

describe("TSE/ASX BUY E2E across additional bases and batched symbols", () => {
  it("USD-base account funds a TSE buy via a single USD→JPY FX leg", () => {
    expect(inferSymbolCurrency("7203.T", "USD")).toBe("JPY");
    expect(inferVenue("7203.T")).toBe("TSE_JP");

    const buy: MultiCcyBudgetOrder = {
      symbol: "7203.T",
      side: "buy",
      quantity: 100,
      price: 3_000, // ¥300,000
      instrument_ccy: "JPY",
    };
    const result = trimBuysToBudgetByCurrency(
      [buy],
      { USD: 10_000, JPY: 0 },
      "USD",
      fx,
      { safetyBufferPct: 0, allowFxConversion: true },
    );

    expect(result.decisions.map((d) => d.kind)).toEqual(["allow"]);
    expect(result.fxLegs).toHaveLength(1);
    const leg = result.fxLegs[0];
    expect(leg.fromCcy).toBe("USD");
    expect(leg.toCcy).toBe("JPY");
    expect(leg.triggeredBySymbol).toBe("7203.T");
    expect(leg.amountTo).toBeCloseTo(300_000, 6);
    expect(leg.amountFrom).toBeCloseTo(300_000 / 150, 6); // $2,000
    expect(leg.rate).toBe(150);

    // USD debited by exactly $2,000; JPY nets to 0 after equity settle.
    expect(result.finalWallet.USD).toBeCloseTo(10_000 - 300_000 / 150, 6);
    expect(result.finalWallet.JPY).toBeCloseTo(0, 9);
  });

  it("EUR-base account funds an ASX buy via a single EUR→AUD FX leg", () => {
    expect(inferSymbolCurrency("BHP.AX", "EUR")).toBe("AUD");
    expect(inferVenue("BHP.AX")).toBe("ASX");

    const buy: MultiCcyBudgetOrder = {
      symbol: "BHP.AX",
      side: "buy",
      quantity: 50,
      price: 40, // A$2,000
      instrument_ccy: "AUD",
    };
    const result = trimBuysToBudgetByCurrency(
      [buy],
      { EUR: 5_000, AUD: 0 },
      "EUR",
      fx,
      { safetyBufferPct: 0, allowFxConversion: true },
    );

    expect(result.decisions.map((d) => d.kind)).toEqual(["allow"]);
    const leg = result.fxLegs[0];
    expect(leg.fromCcy).toBe("EUR");
    expect(leg.toCcy).toBe("AUD");
    expect(leg.amountTo).toBeCloseTo(2_000, 6);
    expect(leg.amountFrom).toBeCloseTo(2_000 / 1.6, 6); // €1,250
    expect(leg.rate).toBe(1.6);

    expect(result.finalWallet.EUR).toBeCloseTo(5_000 - 2_000 / 1.6, 6);
    expect(result.finalWallet.AUD).toBeCloseTo(0, 9);
  });

  it("batched TSE buys emit one FX leg per symbol; native + base totals reconcile", () => {
    // Three Tokyo buys funded from USD in the same trim call.
    const buys: MultiCcyBudgetOrder[] = [
      { symbol: "7203.T", side: "buy", quantity: 100, price: 3_000, instrument_ccy: "JPY" }, // ¥300k
      { symbol: "6758.T", side: "buy", quantity: 20, price: 15_000, instrument_ccy: "JPY" }, // ¥300k
      { symbol: "9984.T", side: "buy", quantity: 10, price: 9_000, instrument_ccy: "JPY" }, //  ¥90k
    ];
    const result = trimBuysToBudgetByCurrency(
      buys,
      { USD: 10_000 },
      "USD",
      fx,
      { safetyBufferPct: 0, allowFxConversion: true },
    );

    expect(result.decisions.map((d) => d.kind)).toEqual(["allow", "allow", "allow"]);
    expect(result.fxLegs).toHaveLength(3);
    expect(result.fxLegs.map((l) => l.triggeredBySymbol)).toEqual([
      "7203.T",
      "6758.T",
      "9984.T",
    ]);

    // Sum of native legs = sum of order notionals (¥690,000).
    const totalJpy = result.fxLegs.reduce((s, l) => s + l.amountTo, 0);
    expect(totalJpy).toBeCloseTo(690_000, 6);
    // Sum of USD debits = totalJpy / 150.
    const totalUsd = result.fxLegs.reduce((s, l) => s + l.amountFrom, 0);
    expect(totalUsd).toBeCloseTo(690_000 / 150, 6);

    // Wallet: USD debited by totalUsd; JPY nets to 0.
    expect(result.finalWallet.USD).toBeCloseTo(10_000 - totalUsd, 6);
    expect(result.finalWallet.JPY).toBeCloseTo(0, 9);
    expect(result.totalRequestedByCcy.JPY).toBeCloseTo(690_000, 6);
    expect(result.totalAllowedByCcy.JPY).toBeCloseTo(690_000, 6);
  });

  it("batched ASX buys from EUR reconcile the same way", () => {
    const buys: MultiCcyBudgetOrder[] = [
      { symbol: "BHP.AX", side: "buy", quantity: 50, price: 40, instrument_ccy: "AUD" }, // A$2,000
      { symbol: "CBA.AX", side: "buy", quantity: 10, price: 110, instrument_ccy: "AUD" }, // A$1,100
      { symbol: "WES.AX", side: "buy", quantity: 20, price: 65, instrument_ccy: "AUD" }, // A$1,300
    ];
    const result = trimBuysToBudgetByCurrency(
      buys,
      { EUR: 10_000 },
      "EUR",
      fx,
      { safetyBufferPct: 0, allowFxConversion: true },
    );

    expect(result.decisions.map((d) => d.kind)).toEqual(["allow", "allow", "allow"]);
    expect(result.fxLegs).toHaveLength(3);

    const totalAud = result.fxLegs.reduce((s, l) => s + l.amountTo, 0);
    expect(totalAud).toBeCloseTo(4_400, 6);
    const totalEur = result.fxLegs.reduce((s, l) => s + l.amountFrom, 0);
    expect(totalEur).toBeCloseTo(4_400 / 1.6, 6);
    expect(result.finalWallet.EUR).toBeCloseTo(10_000 - totalEur, 6);
    expect(result.finalWallet.AUD).toBeCloseTo(0, 9);
  });

  it("equity settle (T+2) matches FX spot settle for USD→JPY and EUR→AUD", () => {
    const trade = new Date(Date.UTC(2026, 2, 2)); // Mon
    expect(ymd(settlementDate(trade, "TSE_JP"))).toBe("2026-03-04");
    expect(ymd(settlementDate(trade, "ASX"))).toBe("2026-03-04");
    // FX spot for the funding legs is also T+2 → cash clears same day.
    expect(ymd(fxSettlementDate(trade, "USD", "JPY"))).toBe("2026-03-04");
    expect(ymd(fxSettlementDate(trade, "EUR", "AUD"))).toBe("2026-03-04");
  });

  it("rejects the buy when the non-GBP base wallet cannot cover FX conversion", () => {
    // Only $100 available — nowhere near enough to buy ¥300,000 at 150.
    const buy: MultiCcyBudgetOrder = {
      symbol: "7203.T",
      side: "buy",
      quantity: 100,
      price: 3_000,
      instrument_ccy: "JPY",
    };
    const result = trimBuysToBudgetByCurrency(
      [buy],
      { USD: 100 },
      "USD",
      fx,
      { safetyBufferPct: 0, allowFxConversion: true },
    );
    const d = result.decisions[0];
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") expect(d.reason).toMatch(/insufficient USD to convert/);
    expect(result.fxLegs).toHaveLength(0);
    expect(result.finalWallet.USD).toBe(100);
  });
});
