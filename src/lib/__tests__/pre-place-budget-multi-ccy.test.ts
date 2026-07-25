import { describe, it, expect } from "vitest";
import {
  trimBuysToBudgetByCurrency,
  type MultiCcyBudgetOrder,
  type FxResolver,
} from "@/lib/pre-place-budget-multi-ccy";

const buy = (
  symbol: string,
  quantity: number,
  price: number,
  instrument_ccy: string,
): MultiCcyBudgetOrder => ({ symbol, side: "buy", quantity, price, instrument_ccy });

// Static FX table: 1 GBP = 1.25 USD = 1.15 EUR. Inverse rates computed.
const rates: Record<string, number> = {
  GBPUSD: 1.25,
  USDGBP: 1 / 1.25,
  GBPEUR: 1.15,
  EURGBP: 1 / 1.15,
  USDEUR: 1.15 / 1.25,
  EURUSD: 1.25 / 1.15,
};
const fx: FxResolver = (from, to) => (from === to ? 1 : (rates[`${from}${to}`] ?? null));

describe("trimBuysToBudgetByCurrency — Phase B routing", () => {
  it("pays from the same-currency wallet balance without generating an FX leg", () => {
    const r = trimBuysToBudgetByCurrency(
      [buy("AAPL", 10, 100, "USD")], // 1,000 USD
      { GBP: 5000, USD: 2000 },
      "GBP",
      fx,
      { safetyBufferPct: 0 },
    );
    expect(r.fxLegs).toEqual([]);
    expect(r.decisions[0].kind).toBe("allow");
    expect(r.finalWallet.USD).toBeCloseTo(1000, 6);
    expect(r.finalWallet.GBP).toBe(5000);
  });

  it("emits an FX conversion leg from base_ccy when the target currency is short", () => {
    // Need 1,000 USD, wallet has 200 USD → shortfall 800 USD.
    // base=GBP, GBP→USD rate = 1.25 → need 800 / 1.25 = 640 GBP.
    const r = trimBuysToBudgetByCurrency(
      [buy("AAPL", 10, 100, "USD")],
      { GBP: 5000, USD: 200 },
      "GBP",
      fx,
      { safetyBufferPct: 0 },
    );
    expect(r.fxLegs).toHaveLength(1);
    const leg = r.fxLegs[0];
    expect(leg.fromCcy).toBe("GBP");
    expect(leg.toCcy).toBe("USD");
    expect(leg.amountFrom).toBeCloseTo(640, 6);
    expect(leg.amountTo).toBeCloseTo(800, 6);
    expect(leg.triggeredBySymbol).toBe("AAPL");
    expect(r.finalWallet.GBP).toBeCloseTo(4360, 6);
    // 200 + 800 credit − 1000 debit = 0.
    expect(r.finalWallet.USD).toBeCloseTo(0, 6);
  });

  it("skips the buy when base cash is insufficient to fund the FX conversion", () => {
    // Need 10,000 USD, wallet has 0 USD, 100 GBP → base has nowhere near enough.
    const r = trimBuysToBudgetByCurrency(
      [buy("AAPL", 100, 100, "USD")],
      { GBP: 100, USD: 0 },
      "GBP",
      fx,
      { safetyBufferPct: 0 },
    );
    expect(r.fxLegs).toEqual([]);
    const d = r.decisions[0];
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") expect(d.reason).toMatch(/insufficient GBP to convert/);
    expect(r.finalWallet.GBP).toBe(100);
  });

  it("skips when the FX pair is unresolvable (both providers down, no cache)", () => {
    const brokenFx: FxResolver = () => null;
    const r = trimBuysToBudgetByCurrency(
      [buy("AAPL", 10, 100, "USD")],
      { GBP: 5000, USD: 0 },
      "GBP",
      brokenFx,
      { safetyBufferPct: 0 },
    );
    const d = r.decisions[0];
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") expect(d.reason).toMatch(/fx GBP->USD unresolved/);
    expect(r.finalWallet.GBP).toBe(5000);
  });

  it("respects allowFxConversion=false — cross-currency short buys just get skipped", () => {
    const r = trimBuysToBudgetByCurrency(
      [buy("AAPL", 10, 100, "USD")],
      { GBP: 5000, USD: 200 },
      "GBP",
      fx,
      { safetyBufferPct: 0, allowFxConversion: false },
    );
    expect(r.fxLegs).toEqual([]);
    const d = r.decisions[0];
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") expect(d.reason).toMatch(/fx disabled/);
  });

  it("walks multiple currencies in order and only generates the FX leg for the short one", () => {
    // 500 EUR trade (has EUR cash) + 1000 USD trade (short USD, needs FX).
    const r = trimBuysToBudgetByCurrency(
      [buy("VOD.L", 10, 50, "EUR"), buy("AAPL", 10, 100, "USD")],
      { GBP: 5000, USD: 200, EUR: 600 },
      "GBP",
      fx,
      { safetyBufferPct: 0 },
    );
    expect(r.decisions.map((d) => d.kind)).toEqual(["allow", "allow"]);
    expect(r.fxLegs).toHaveLength(1);
    expect(r.fxLegs[0].toCcy).toBe("USD");
    expect(r.finalWallet.EUR).toBeCloseTo(100, 6);
  });

  it("applies the safety buffer per-currency so a buy at the raw edge is skipped", () => {
    // USD wallet 1000, buy needs 1000. With 1% buffer, buffered = 990 → skip.
    const r = trimBuysToBudgetByCurrency(
      [buy("AAPL", 10, 100, "USD")],
      { GBP: 0, USD: 1000 },
      "GBP",
      fx,
      { safetyBufferPct: 0.01, allowFxConversion: false },
    );
    expect(r.decisions[0].kind).toBe("skip");
  });

  it("flags an FX leg as stale when the resolver reports the pair is fallback/stale", () => {
    const r = trimBuysToBudgetByCurrency(
      [buy("AAPL", 10, 100, "USD")],
      { GBP: 5000, USD: 0 },
      "GBP",
      fx,
      { safetyBufferPct: 0, isRateStale: (f, t) => f === "GBP" && t === "USD" },
    );
    expect(r.fxLegs[0].stale).toBe(true);
  });

  it("does not consume base_ccy cash needed for a base-currency buy later in the batch", () => {
    // Two buys: USD short (needs FX from 5000 GBP), then a big GBP buy.
    // If the FX conversion is greedy the GBP buy will be short.
    // GBP wallet 5000; USD trade needs 1000 USD → 800 GBP FX leg.
    // Second trade needs 4500 GBP → only 4200 remain → skip.
    const r = trimBuysToBudgetByCurrency(
      [buy("AAPL", 10, 100, "USD"), buy("VOD.L", 45, 100, "GBP")],
      { GBP: 5000, USD: 0 },
      "GBP",
      fx,
      { safetyBufferPct: 0 },
    );
    expect(r.decisions[0].kind).toBe("allow");
    expect(r.decisions[1].kind).toBe("skip");
  });
});
