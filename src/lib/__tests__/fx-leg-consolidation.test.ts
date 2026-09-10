import { describe, expect, it } from "vitest";
import { consolidateFxLegs } from "../fx-leg-consolidation";
import type { FxLeg } from "../pre-place-budget-multi-ccy";

const leg = (sym: string, amountFrom: number, rate = 1.3): FxLeg => ({
  fromCcy: "GBP",
  toCcy: "USD",
  amountFrom,
  amountTo: amountFrom * rate,
  rate,
  stale: false,
  triggeredBySymbol: sym,
});

describe("consolidateFxLegs", () => {
  it("merges same-pair legs into one conversion", () => {
    const out = consolidateFxLegs([leg("AAPL", 300), leg("MSFT", 800)], {
      available: { GBP: 8000 },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.amountFrom).toBeCloseTo(1100);
    expect(out[0]!.triggerSymbols).toEqual(["AAPL", "MSFT"]);
    expect(out[0]!.toppedUp).toBe(false);
  });

  it("tops a sub-minimum conversion up when cash allows", () => {
    const out = consolidateFxLegs([leg("AAPL", 300), leg("MSFT", 330)], {
      available: { GBP: 8284 },
    });
    expect(out[0]!.amountFrom).toBe(1000);
    expect(out[0]!.amountTo).toBeCloseTo(1300);
    expect(out[0]!.toppedUp).toBe(true);
    expect(out[0]!.requiredFrom).toBeCloseTo(630);
  });

  it("reports a shortfall instead of topping up beyond the wallet", () => {
    const out = consolidateFxLegs([leg("AAPL", 300)], { available: { GBP: 500 } });
    expect(out[0]!.toppedUp).toBe(false);
    expect(out[0]!.shortfallReason).toContain("1000 GBP minimum");
  });

  it("keeps distinct pairs separate", () => {
    const eur: FxLeg = { ...leg("SAP", 1200), toCcy: "EUR" };
    const out = consolidateFxLegs([leg("AAPL", 1500), eur], { available: { GBP: 9000 } });
    expect(out).toHaveLength(2);
  });
});
