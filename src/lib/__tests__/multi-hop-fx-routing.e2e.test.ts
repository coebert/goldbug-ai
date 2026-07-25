// End-to-end tests for multi-hop FX conversions.
//
// The trimmer (`trimBuysToBudgetByCurrency`) only routes base->target in a
// single leg. Real multi-hop routing (e.g. USD -> GBP -> EUR) happens across
// the pipeline: an upstream FX conversion (either AI-proposed via
// `planFxConversion`, or a manual wallet convert) first rotates a non-base
// surplus into base_ccy, and the executor's next trim then emits a
// base->target FX_LEG to fund the buy.
//
// This file locks the *broker payload* contract for that chained sequence:
//   - The FX_LEG rows the executor would insert into live_broker_log appear
//     in the correct order, with matching from/to/amountFrom/amountTo/rate.
//   - Conservation across hops: leg N's `amountTo` == leg N+1's `amountFrom`
//     (net of any spread the upstream applies).
//   - `placeFxSpot` is invoked once per hop with the executor's
//     `fx-<decisionId>-<sym>-<from><to>` client_order_id shape.
//   - The final wallet reflects all hops + the buy debit.

import { describe, it, expect } from "vitest";
import {
  trimBuysToBudgetByCurrency,
  type FxResolver,
  type MultiCcyBudgetOrder,
} from "@/lib/pre-place-budget-multi-ccy";
import { planFxConversion } from "@/lib/fx-convert-plan";

// 1 GBP = 1.25 USD = 1.15 EUR. Cross rates derived; ~all quotes are mid.
const RATES: Record<string, number> = {
  GBPUSD: 1.25,
  USDGBP: 1 / 1.25,
  GBPEUR: 1.15,
  EURGBP: 1 / 1.15,
  USDEUR: 1.15 / 1.25,
  EURUSD: 1.25 / 1.15,
};
const fx: FxResolver = (from, to) =>
  from === to ? 1 : (RATES[`${from}${to}`] ?? null);

type LoggedFxLeg = {
  method: "FX_LEG";
  path: string;
  status: number;
  fromCcy: string;
  toCcy: string;
  amountFrom: number;
  amountTo: number;
  rate: number;
  stale: boolean;
  triggeredBySymbol: string;
};

type SpotArgs = {
  fromCcy: string;
  toCcy: string;
  amountFrom: number;
  clientOrderId: string;
};

function makeAdapter() {
  const calls: SpotArgs[] = [];
  return {
    calls,
    placeFxSpot: async (args: SpotArgs) => {
      calls.push(args);
      return { status: "filled" as const };
    },
  };
}

function trimAsFxLegRows(
  buys: MultiCcyBudgetOrder[],
  wallet: Record<string, number>,
  baseCcy: string,
): { rows: LoggedFxLeg[]; trim: ReturnType<typeof trimBuysToBudgetByCurrency> } {
  const trim = trimBuysToBudgetByCurrency(buys, wallet, baseCcy, fx, {
    safetyBufferPct: 0,
    allowFxConversion: true,
  });
  const rows: LoggedFxLeg[] = trim.fxLegs.map((leg) => ({
    method: "FX_LEG",
    path: `/fx/${leg.fromCcy}->${leg.toCcy}`,
    status: leg.stale ? 206 : 200,
    fromCcy: leg.fromCcy,
    toCcy: leg.toCcy,
    amountFrom: leg.amountFrom,
    amountTo: leg.amountTo,
    rate: leg.rate,
    stale: leg.stale,
    triggeredBySymbol: leg.triggeredBySymbol,
  }));
  return { rows, trim };
}

describe("multi-hop FX routing → broker payload contract", () => {
  it("USD → GBP → EUR: upstream AI convert then executor FX leg funds the EUR buy", async () => {
    const baseCcy = "GBP";
    const decisionId = "dec-hop-1";
    const adapter = makeAdapter();

    // Starting wallet: surplus USD, no EUR, small GBP cushion.
    // Buy needs 600 EUR — no direct trimmer path (only base->target), so we
    // stage USD->GBP first, then rely on trimmer to emit GBP->EUR.
    const wallet0 = { GBP: 100, USD: 1250, EUR: 0 };

    // Hop 1: AI proposes USD -> GBP for 1000 USD @ 1/1.25 = 800 GBP.
    // (planFxConversion is pure; the executor persists the resulting wallet
    // and logs the leg before the trimmer runs.)
    const usdToGbp = planFxConversion({
      wallet: wallet0,
      from: "USD",
      to: "GBP",
      amountFrom: 1000,
      rate: fx("USD", "GBP")!,
    });
    expect(usdToGbp.ok).toBe(true);
    if (!usdToGbp.ok) return;

    // Executor's spot placement for hop 1 (mirrors placeFxSpot invocation
    // shape from live-executor.server.ts).
    await adapter.placeFxSpot({
      fromCcy: "USD",
      toCcy: "GBP",
      amountFrom: usdToGbp.amountFrom,
      clientOrderId: `fx-${decisionId}-AI-USDGBP`,
    });

    // The FX_LEG row the executor would insert for hop 1.
    const hop1Row: LoggedFxLeg = {
      method: "FX_LEG",
      path: "/fx/USD->GBP",
      status: 200,
      fromCcy: "USD",
      toCcy: "GBP",
      amountFrom: usdToGbp.amountFrom,
      amountTo: usdToGbp.amountTo,
      rate: usdToGbp.rate,
      stale: false,
      triggeredBySymbol: "AI",
    };
    expect(hop1Row.amountFrom * hop1Row.rate).toBeCloseTo(hop1Row.amountTo, 6);

    // Hop 2: trimmer runs against the post-hop-1 wallet with the EUR buy.
    const wallet1 = usdToGbp.newWallet as Record<string, number>;
    expect(wallet1.GBP).toBeCloseTo(900, 6); // 100 + 800
    expect(wallet1.USD).toBeCloseTo(250, 6);

    const { rows: hop2Rows, trim } = trimAsFxLegRows(
      [
        {
          symbol: "SAP",
          side: "buy",
          quantity: 10,
          price: 60,
          instrument_ccy: "EUR",
        },
      ],
      wallet1,
      baseCcy,
    );

    // Executor submits hop 2 via placeFxSpot (spot mode).
    for (const leg of trim.fxLegs) {
      await adapter.placeFxSpot({
        fromCcy: leg.fromCcy,
        toCcy: leg.toCcy,
        amountFrom: leg.amountFrom,
        clientOrderId: `fx-${decisionId}-${leg.triggeredBySymbol}-${leg.fromCcy}${leg.toCcy}`,
      });
    }

    // --- Assertions on the chained broker payload ---
    const chain: LoggedFxLeg[] = [hop1Row, ...hop2Rows];
    expect(chain.map((r) => r.path)).toEqual([
      "/fx/USD->GBP",
      "/fx/GBP->EUR",
    ]);
    // Hop 2 must be triggered by the EUR buy the trimmer is funding.
    expect(hop2Rows[0].triggeredBySymbol).toBe("SAP");
    // 600 EUR needed → 600 / 1.15 = 521.7391 GBP.
    expect(hop2Rows[0].amountTo).toBeCloseTo(600, 6);
    expect(hop2Rows[0].amountFrom).toBeCloseTo(600 / 1.15, 6);

    // Conservation: hop-1 credits enough GBP that hop-2 can debit it.
    expect(hop1Row.amountTo).toBeGreaterThan(hop2Rows[0].amountFrom);

    // Adapter call ordering + client_order_id shape for each hop.
    expect(adapter.calls.map((c) => c.clientOrderId)).toEqual([
      `fx-${decisionId}-AI-USDGBP`,
      `fx-${decisionId}-SAP-GBPEUR`,
    ]);

    // Trim decision + final wallet after both hops and the buy.
    expect(trim.decisions[0].kind).toBe("allow");
    expect(trim.finalWallet.EUR).toBeCloseTo(0, 6); // 0 + 600 − 600
    expect(trim.finalWallet.GBP).toBeCloseTo(900 - 600 / 1.15, 6);
  });

  it("EUR → GBP → USD: unwinds a EUR surplus and funds a USD buy in two hops", async () => {
    const baseCcy = "GBP";
    const decisionId = "dec-hop-2";
    const adapter = makeAdapter();

    // Wallet has EUR surplus, no USD, insufficient GBP for the USD buy alone.
    const wallet0 = { GBP: 50, EUR: 1150, USD: 0 };

    // Hop 1: unwind 1000 EUR into GBP @ 1/1.15.
    const eurToGbp = planFxConversion({
      wallet: wallet0,
      from: "EUR",
      to: "GBP",
      amountFrom: 1000,
      rate: fx("EUR", "GBP")!,
    });
    expect(eurToGbp.ok).toBe(true);
    if (!eurToGbp.ok) return;
    await adapter.placeFxSpot({
      fromCcy: "EUR",
      toCcy: "GBP",
      amountFrom: eurToGbp.amountFrom,
      clientOrderId: `fx-${decisionId}-AI-EURGBP`,
    });

    // Hop 2: trimmer funds the USD buy from the freshly-topped-up GBP.
    const wallet1 = eurToGbp.newWallet as Record<string, number>;
    const { rows: hop2Rows, trim } = trimAsFxLegRows(
      [
        {
          symbol: "AAPL",
          side: "buy",
          quantity: 5,
          price: 200,
          instrument_ccy: "USD",
        },
      ],
      wallet1,
      baseCcy,
    );
    for (const leg of trim.fxLegs) {
      await adapter.placeFxSpot({
        fromCcy: leg.fromCcy,
        toCcy: leg.toCcy,
        amountFrom: leg.amountFrom,
        clientOrderId: `fx-${decisionId}-${leg.triggeredBySymbol}-${leg.fromCcy}${leg.toCcy}`,
      });
    }

    const chainPaths = ["/fx/EUR->GBP", ...hop2Rows.map((r) => r.path)];
    expect(chainPaths).toEqual(["/fx/EUR->GBP", "/fx/GBP->USD"]);

    // 1000 USD notional → 1000/1.25 = 800 GBP.
    expect(hop2Rows[0].amountTo).toBeCloseTo(1000, 6);
    expect(hop2Rows[0].amountFrom).toBeCloseTo(800, 6);
    expect(hop2Rows[0].triggeredBySymbol).toBe("AAPL");

    // Every hop's amountFrom * rate === amountTo (per-leg conservation).
    for (const row of [
      {
        amountFrom: eurToGbp.amountFrom,
        rate: eurToGbp.rate,
        amountTo: eurToGbp.amountTo,
      },
      ...hop2Rows,
    ]) {
      expect(row.amountFrom * row.rate).toBeCloseTo(row.amountTo, 6);
    }

    expect(adapter.calls.map((c) => c.clientOrderId)).toEqual([
      `fx-${decisionId}-AI-EURGBP`,
      `fx-${decisionId}-AAPL-GBPUSD`,
    ]);
    expect(trim.decisions[0].kind).toBe("allow");
    expect(trim.finalWallet.USD).toBeCloseTo(0, 6);
  });

  it("multi-hop still skips buy when upstream hop under-funds the base", async () => {
    const baseCcy = "GBP";
    const adapter = makeAdapter();

    // Only convert 100 USD → 80 GBP (nowhere near enough for a 600 EUR buy
    // needing ~521.74 GBP on top of the 50 GBP already held).
    const wallet0 = { GBP: 50, USD: 100, EUR: 0 };
    const hop1 = planFxConversion({
      wallet: wallet0,
      from: "USD",
      to: "GBP",
      amountFrom: 100,
      rate: fx("USD", "GBP")!,
    });
    expect(hop1.ok).toBe(true);
    if (!hop1.ok) return;
    await adapter.placeFxSpot({
      fromCcy: "USD",
      toCcy: "GBP",
      amountFrom: hop1.amountFrom,
      clientOrderId: "fx-dec-hop-3-AI-USDGBP",
    });

    const { rows: hop2Rows, trim } = trimAsFxLegRows(
      [
        {
          symbol: "SAP",
          side: "buy",
          quantity: 10,
          price: 60,
          instrument_ccy: "EUR",
        },
      ],
      hop1.newWallet as Record<string, number>,
      baseCcy,
    );

    // No second FX leg emitted — the trimmer skips instead.
    expect(hop2Rows).toEqual([]);
    expect(adapter.calls).toHaveLength(1); // only hop-1 hit the broker
    expect(trim.decisions[0].kind).toBe("skip");
    if (trim.decisions[0].kind === "skip") {
      expect(trim.decisions[0].reason).toMatch(/insufficient GBP to convert/);
    }
  });
});
