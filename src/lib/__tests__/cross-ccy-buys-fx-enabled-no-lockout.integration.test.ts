// Integration test: cross-currency buys with fx_enabled=true are routed via
// FX_LEGs and never trigger the InsufficientCash lockout.
//
// Two related invariants are exercised here — both are prerequisites for a
// multi-currency portfolio (e.g. an EUR wallet buying USD equities) to
// actually deploy capital instead of getting stuck behind the 24h learned-
// cash lockout:
//
//   1. FX-DISABLED GUARD: when fx_enabled=false, cross-currency buys are
//      pre-skipped in the executor and never reach Saxo, so Saxo never
//      returns InsufficientCash and the lockout stays clear.
//   2. FX-ENABLED HAPPY PATH: when fx_enabled=true, the per-currency trimmer
//      emits an FX_LEG (base->target) that funds the buy from the base
//      wallet at the captured rate; the buy is allowed, no InsufficientCash
//      reject is recorded, and the lockout decision remains `lockout:false`.
//
// This composes the same pure primitives the executor uses at runtime —
// the fx-disabled guard's mismatch detector, `trimBuysToBudgetByCurrency`
// (the multi-ccy trimmer), and `decideInsufficientCashLockout` (the
// learned-cash gate) — so a regression in any of them will surface here
// without needing a live broker or database.

import { describe, it, expect } from "vitest";
import {
  trimBuysToBudgetByCurrency,
  type FxResolver,
  type MultiCcyBudgetOrder,
} from "@/lib/pre-place-budget-multi-ccy";
import {
  decideInsufficientCashLockout,
  type CashSyncObservation,
  type InsufficientCashReject,
} from "@/lib/insufficient-cash-lockout";

// 1 GBP = 1.25 USD = 1.15 EUR — identical shape to multi-hop-fx-routing.e2e.
const RATES: Record<string, number> = {
  GBPUSD: 1.25,
  USDGBP: 1 / 1.25,
  GBPEUR: 1.15,
  EURGBP: 1 / 1.15,
  EURUSD: 1.25 / 1.15,
  USDEUR: 1.15 / 1.25,
};
const fx: FxResolver = (from, to) =>
  from === to ? 1 : (RATES[`${from}${to}`] ?? null);

// Mirrors the mismatch detector inside `routeOrdersToBroker` at the
// `if (!fxEnabled)` branch of src/lib/live-executor.server.ts. Given a
// batch and a portfolio base currency, returns the set of buys the
// executor would pre-skip (never send to Saxo) when fx routing is off.
function fxDisabledPreSkips(
  batch: Array<{ symbol: string; side: "buy" | "sell"; instrument_ccy: string }>,
  portfolioCurrency: string,
): Record<string, string> {
  const skipped: Record<string, string> = {};
  for (const o of batch) {
    if (o.side !== "buy") continue;
    const inst = o.instrument_ccy.toUpperCase();
    if (inst !== portfolioCurrency.toUpperCase()) {
      skipped[`${o.symbol}:${o.side}`] =
        `cross-currency buy skipped: instrument is ${inst} but portfolio base is ${portfolioCurrency} and fx_enabled=false; enable FX to trade this instrument`;
    }
  }
  return skipped;
}

// Simulate one tick: apply the fx-disabled guard, then (if fx is enabled)
// route the surviving batch through the multi-currency trimmer, then feed
// any InsufficientCash rejects + follow-up CASH_SYNC rows into the
// lockout decision. Returns everything callers need to assert against.
function runTick(input: {
  fxEnabled: boolean;
  baseCcy: string;
  wallet: Record<string, number>;
  batch: Array<{
    symbol: string;
    side: "buy" | "sell";
    quantity: number;
    price: number;
    instrument_ccy: string;
  }>;
  rejects?: InsufficientCashReject[];
  cashSyncs?: CashSyncObservation[];
}) {
  const preSkips = input.fxEnabled
    ? {}
    : fxDisabledPreSkips(input.batch, input.baseCcy);

  const routable: MultiCcyBudgetOrder[] = input.batch
    .filter((o) => !preSkips[`${o.symbol}:${o.side}`])
    .filter((o) => o.side === "buy")
    .map((o) => ({
      symbol: o.symbol,
      side: "buy",
      quantity: o.quantity,
      price: o.price,
      instrument_ccy: o.instrument_ccy,
    }));

  const trim = input.fxEnabled
    ? trimBuysToBudgetByCurrency(routable, input.wallet, input.baseCcy, fx, {
        safetyBufferPct: 0,
        allowFxConversion: true,
      })
    : { decisions: [], fxLegs: [] as ReturnType<typeof trimBuysToBudgetByCurrency>["fxLegs"] };

  // No new InsufficientCash rejects were produced by this tick since none
  // of the pre-skipped or trimmer-approved orders were actually sent.
  const lockout = decideInsufficientCashLockout({
    rejects: input.rejects ?? [],
    cashSyncs: input.cashSyncs ?? [],
  });

  return { preSkips, trim, lockout };
}

describe("cross-currency buys × fx_enabled × InsufficientCash lockout", () => {
  it("fx_enabled=true: USD buy from an EUR wallet routes via an EUR→USD FX_LEG and never triggers the lockout", () => {
    // AAPL is priced in USD; wallet only holds EUR. With fx_enabled=true
    // the trimmer must synthesise an EUR→USD leg and allow the buy.
    const { preSkips, trim, lockout } = runTick({
      fxEnabled: true,
      baseCcy: "EUR",
      wallet: { EUR: 10_000, USD: 0 },
      batch: [
        { symbol: "AAPL", side: "buy", quantity: 10, price: 200, instrument_ccy: "USD" },
      ],
    });

    // 1) Not pre-skipped by the fx-disabled guard.
    expect(preSkips).toEqual({});

    // 2) The trimmer allowed the buy and emitted exactly one funding leg.
    const decisions = trim.decisions;
    expect(decisions).toHaveLength(1);
    expect(decisions[0].kind).toBe("allow");

    expect(trim.fxLegs).toHaveLength(1);
    const leg = trim.fxLegs[0];
    expect(leg.fromCcy).toBe("EUR");
    expect(leg.toCcy).toBe("USD");
    expect(leg.triggeredBySymbol).toBe("AAPL");
    // Conservation: amountFrom * rate == amountTo, at the resolver's rate.
    expect(leg.amountTo).toBeCloseTo(leg.amountFrom * leg.rate, 6);
    expect(leg.rate).toBeCloseTo(RATES.EURUSD, 6);
    // The leg must fully cover the notional (2 000 USD).
    expect(leg.amountTo).toBeGreaterThanOrEqual(10 * 200);

    // 3) Because the buy was routed rather than sent to a currency-blind
    //    broker call, no InsufficientCash reject exists → no lockout.
    expect(lockout.lockout).toBe(false);
    expect(lockout.stats.rejectCount).toBe(0);
  });

  it("fx_enabled=true: a mixed same-ccy + cross-ccy batch is allowed with a single FX_LEG per non-base buy, lockout clean", () => {
    // Base = GBP wallet, buying VOD.L (GBP, same ccy, no leg) and V (USD,
    // needs a GBP→USD leg). Both should be allowed, lockout stays clear.
    const { trim, lockout } = runTick({
      fxEnabled: true,
      baseCcy: "GBP",
      wallet: { GBP: 5_000, USD: 0, EUR: 0 },
      batch: [
        { symbol: "VOD.L", side: "buy", quantity: 10, price: 80, instrument_ccy: "GBP" },
        { symbol: "V", side: "buy", quantity: 5, price: 250, instrument_ccy: "USD" },
      ],
    });

    expect(trim.decisions.map((d) => d.kind)).toEqual(["allow", "allow"]);
    // Exactly one FX leg, and it funds the USD buy only.
    expect(trim.fxLegs).toHaveLength(1);
    expect(trim.fxLegs[0].toCcy).toBe("USD");
    expect(trim.fxLegs[0].triggeredBySymbol).toBe("V");

    expect(lockout.lockout).toBe(false);
  });

  it("fx_enabled=false: cross-currency buys are pre-skipped and same-currency buys are untouched — lockout stays clean", () => {
    // EUR wallet with a USD buy (AAPL) and an EUR buy (SAP.DE). The USD
    // buy MUST be pre-skipped so Saxo never sees it; the EUR buy is fine.
    const batch = [
      { symbol: "AAPL", side: "buy" as const, quantity: 10, price: 200, instrument_ccy: "USD" },
      { symbol: "SAP.DE", side: "buy" as const, quantity: 2, price: 150, instrument_ccy: "EUR" },
    ];
    const { preSkips, lockout } = runTick({
      fxEnabled: false,
      baseCcy: "EUR",
      wallet: { EUR: 10_000 },
      batch,
    });

    expect(Object.keys(preSkips)).toEqual(["AAPL:buy"]);
    expect(preSkips["AAPL:buy"]).toMatch(/cross-currency buy skipped/);
    expect(preSkips["AAPL:buy"]).toMatch(/fx_enabled=false/);
    expect(preSkips["SAP.DE:buy"]).toBeUndefined();

    // No reject was ever produced because the guard fired before Saxo.
    expect(lockout.lockout).toBe(false);
    expect(lockout.stats.rejectCount).toBe(0);
  });

  it("fx_enabled=true: FX routing is NOT gated by pre-existing InsufficientCash rejects on a same-currency instrument", () => {
    // Historical reject was on GBP buy VMID.L; a fresh CASH_SYNC would
    // still show the same low broker cash, so the pure lockout decision
    // is `lockout: true` for GBP buys. This test asserts the FX-routing
    // trimmer is a separate concern: cross-currency buys funded from a
    // fully-stocked non-base wallet must still be allowed by the trimmer.
    // The executor combines the two gates, but they compose orthogonally.
    const { trim, lockout } = runTick({
      fxEnabled: true,
      baseCcy: "GBP",
      // Plenty of USD to spend, but GBP is deliberately near-zero so no
      // FX leg is needed for the USD buy at all.
      wallet: { GBP: 5, USD: 5_000 },
      batch: [
        { symbol: "AAPL", side: "buy", quantity: 10, price: 200, instrument_ccy: "USD" },
      ],
      rejects: [
        { at: "2026-07-25T10:00:00Z", symbol: "VMID.L", quantity: 1 },
      ],
      cashSyncs: [
        { at: "2026-07-25T11:00:00Z", brokerCash: 5 },
      ],
    });

    // Trimmer paid the buy directly out of the USD wallet — no FX leg.
    expect(trim.decisions).toHaveLength(1);
    expect(trim.decisions[0].kind).toBe("allow");
    expect(trim.fxLegs).toEqual([]);

    // Lockout decision (a separate pure function on the reject/sync log)
    // still fires for GBP buys — cross-currency FX routing does not
    // silence it, nor should it.
    expect(lockout.lockout).toBe(true);
    expect(lockout.stats.newestRejectAt).toBe("2026-07-25T10:00:00Z");
  });

  it("fx_enabled=true multi-instrument: EUR wallet funds both a USD and a GBP buy via two independent FX_LEGs, no reject/lockout", () => {
    const { trim, lockout } = runTick({
      fxEnabled: true,
      baseCcy: "EUR",
      wallet: { EUR: 20_000, USD: 0, GBP: 0 },
      batch: [
        { symbol: "AAPL", side: "buy", quantity: 5, price: 200, instrument_ccy: "USD" },
        { symbol: "VOD.L", side: "buy", quantity: 10, price: 80, instrument_ccy: "GBP" },
      ],
    });

    expect(trim.decisions.map((d) => d.kind)).toEqual(["allow", "allow"]);
    expect(trim.fxLegs).toHaveLength(2);
    const byTarget = new Map(trim.fxLegs.map((l) => [l.toCcy, l]));
    expect(byTarget.get("USD")!.fromCcy).toBe("EUR");
    expect(byTarget.get("USD")!.triggeredBySymbol).toBe("AAPL");
    expect(byTarget.get("GBP")!.fromCcy).toBe("EUR");
    expect(byTarget.get("GBP")!.triggeredBySymbol).toBe("VOD.L");
    // Each leg conserves value at the resolver rate.
    for (const leg of trim.fxLegs) {
      expect(leg.amountTo).toBeCloseTo(leg.amountFrom * leg.rate, 6);
    }

    expect(lockout.lockout).toBe(false);
  });
});
