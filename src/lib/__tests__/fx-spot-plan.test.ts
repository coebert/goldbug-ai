import { describe, expect, it } from "vitest";
import { survivingBuysAfterFxSpot } from "../fx-spot-plan";
import { trimBuysToBudgetByCurrency } from "../pre-place-budget-multi-ccy";

describe("survivingBuysAfterFxSpot", () => {
  const buys = [
    { symbol: "AAPL", side: "buy" as const, quantity: 10, price: 100, instrument_ccy: "USD" }, // needs USD 1000
    { symbol: "SAP",  side: "buy" as const, quantity: 5,  price: 50,  instrument_ccy: "EUR" }, // needs EUR 250
    { symbol: "BP",   side: "buy" as const, quantity: 100, price: 5,  instrument_ccy: "GBP" }, // GBP 500, in-ccy
  ];
  const wallet = { GBP: 2000, USD: 0, EUR: 0 };
  const fx = (f: string, t: string) => {
    if (f === t) return 1;
    if (f === "GBP" && t === "USD") return 1.25;
    if (f === "GBP" && t === "EUR") return 1.15;
    return null;
  };

  it("keeps every buy when all FX legs succeeded", () => {
    const trim = trimBuysToBudgetByCurrency(buys, wallet, "GBP", fx, { safetyBufferPct: 0 });
    // 2 legs (USD & EUR) expected
    expect(trim.fxLegs.length).toBe(2);
    const res = survivingBuysAfterFxSpot(buys, trim, [
      { kind: "ok", triggerSymbol: "AAPL", fillRate: 1.25, amountTo: 1000 },
      { kind: "ok", triggerSymbol: "SAP",  fillRate: 1.15, amountTo: 250 },
    ]);
    expect(res.survivors.map((s) => s.symbol)).toEqual(["AAPL", "SAP", "BP"]);
    expect(res.droppedSymbols.size).toBe(0);
  });

  it("drops the buy whose FX leg failed and keeps unrelated buys", () => {
    const trim = trimBuysToBudgetByCurrency(buys, wallet, "GBP", fx, { safetyBufferPct: 0 });
    const res = survivingBuysAfterFxSpot(buys, trim, [
      { kind: "failed", triggerSymbol: "AAPL", reason: "InsufficientCash at broker" },
      { kind: "ok",     triggerSymbol: "SAP",  fillRate: 1.15, amountTo: 250 },
    ]);
    expect(res.survivors.map((s) => s.symbol).sort()).toEqual(["BP", "SAP"]);
    expect(res.droppedSymbols.get("AAPL")).toMatch(/InsufficientCash/);
  });

  it("does not drop same-ccy buys that never needed FX", () => {
    const trim = trimBuysToBudgetByCurrency(buys, wallet, "GBP", fx, { safetyBufferPct: 0 });
    const res = survivingBuysAfterFxSpot(buys, trim, [
      { kind: "failed", triggerSymbol: "AAPL", reason: "boom" },
      { kind: "failed", triggerSymbol: "SAP",  reason: "boom" },
    ]);
    expect(res.survivors.map((s) => s.symbol)).toEqual(["BP"]);
    expect(res.droppedSymbols.size).toBe(2);
  });
});
