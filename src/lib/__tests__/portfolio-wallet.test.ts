import { describe, it, expect } from "vitest";
import {
  readWallet,
  walletBalance,
  applyDelta,
  writeWalletFields,
} from "@/lib/portfolio-wallet";

describe("portfolio-wallet — back-compat wallet shim", () => {
  it("falls back to { base: current_cash } when cash_by_ccy is empty", () => {
    const w = readWallet({ currency: "GBP", current_cash: 1234, cash_by_ccy: {} });
    expect(w).toEqual({ GBP: 1234 });
  });

  it("uses cash_by_ccy when populated and uppercases keys", () => {
    const w = readWallet({
      currency: "GBP",
      current_cash: 100,
      cash_by_ccy: { gbp: 500, usd: 200 },
    });
    expect(w).toEqual({ GBP: 500, USD: 200 });
  });

  it("guarantees the base currency exists in the returned wallet", () => {
    const w = readWallet({
      currency: "GBP",
      current_cash: 42,
      cash_by_ccy: { USD: 100 }, // no GBP
    });
    expect(w.GBP).toBe(42);
    expect(w.USD).toBe(100);
  });

  it("walletBalance returns 0 for missing / bad currencies", () => {
    expect(walletBalance({ GBP: 100 }, "usd")).toBe(0);
    expect(walletBalance({ GBP: Number.NaN }, "GBP")).toBe(0);
  });

  it("applyDelta creates the bucket if missing and preserves existing ones", () => {
    const w = applyDelta({ GBP: 100 }, "USD", 50);
    expect(w).toEqual({ GBP: 100, USD: 50 });
    const w2 = applyDelta(w, "usd", -20);
    expect(w2.USD).toBe(30);
    expect(w2.GBP).toBe(100);
  });

  it("writeWalletFields mirrors the base bucket to current_cash", () => {
    const out = writeWalletFields({ GBP: 500, USD: 300 }, "GBP");
    expect(out.current_cash).toBe(500);
    expect(out.cash_by_ccy).toEqual({ GBP: 500, USD: 300 });
  });

  it("writeWalletFields uppercases keys and coerces bad numbers to 0", () => {
    // deliberately loose input
    const out = writeWalletFields({ gbp: 10, usd: Number.NaN } as unknown as Record<string, number>, "gbp");
    expect(out.cash_by_ccy).toEqual({ GBP: 10, USD: 0 });
    expect(out.current_cash).toBe(10);
  });
});
