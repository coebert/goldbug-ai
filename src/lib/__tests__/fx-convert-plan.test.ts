import { describe, it, expect } from "vitest";
import { planFxConversion } from "@/lib/fx-convert-plan";

describe("planFxConversion", () => {
  const wallet = { GBP: 1000, USD: 50, EUR: 0 };

  it("rejects when from and to are the same currency", () => {
    const p = planFxConversion({ wallet, from: "GBP", to: "GBP", amountFrom: 100, rate: 1 });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe("SAME_CURRENCY");
  });

  it("rejects zero and negative amounts", () => {
    for (const amt of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = planFxConversion({ wallet, from: "GBP", to: "USD", amountFrom: amt, rate: 1.25 });
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.reason).toBe("INVALID_AMOUNT");
    }
  });

  it("rejects non-positive rates", () => {
    const p = planFxConversion({ wallet, from: "GBP", to: "USD", amountFrom: 100, rate: 0 });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe("INVALID_RATE");
  });

  it("rejects when the source currency balance is too low", () => {
    const p = planFxConversion({ wallet, from: "USD", to: "GBP", amountFrom: 100, rate: 0.8 });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe("INSUFFICIENT_CASH");
  });

  it("debits from-currency and credits to-currency at the supplied rate", () => {
    const p = planFxConversion({ wallet, from: "GBP", to: "USD", amountFrom: 400, rate: 1.25 });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.amountTo).toBe(500);
      expect(p.newWallet.GBP).toBe(600);
      expect(p.newWallet.USD).toBe(550);
      // Untouched currencies survive.
      expect(p.newWallet.EUR).toBe(0);
    }
  });

  it("creates the destination currency entry when the wallet had none", () => {
    const p = planFxConversion({
      wallet: { GBP: 500 },
      from: "GBP",
      to: "JPY",
      amountFrom: 100,
      rate: 190,
    });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.newWallet.JPY).toBe(19000);
      expect(p.newWallet.GBP).toBe(400);
    }
  });

  it("accepts amounts within floating-point tolerance of the balance", () => {
    const p = planFxConversion({
      wallet: { GBP: 100 },
      from: "GBP",
      to: "USD",
      amountFrom: 100 + 1e-9,
      rate: 1.25,
    });
    expect(p.ok).toBe(true);
  });
});
