// End-to-end: dependent multi-currency buys reach the broker only after
// their spot FX legs succeed. Unfunded FX legs must never produce a
// downstream buy on the broker.
//
// This mirrors the executor sequence in `src/lib/live-executor.server.ts`
// (Phase B/C, fxExecutionMode === 'spot' branch):
//
//   1. trimBuysToBudgetByCurrency   → plan per-currency legs + decisions
//   2. adapter.placeFxSpot(...)     → submit FX legs first
//   3. survivingBuysAfterFxSpot     → drop buys whose leg failed
//   4. re-trim survivors            → recompute wallet + legs
//   5. adapter.placeOrder(...)      → submit remaining equity orders
//
// Asserts:
//   • Order-of-operations: every FX leg is placed BEFORE any equity buy.
//   • Adapter-supported spot: FX_LEG rows land at broker (one placeFxSpot
//     call per surviving leg) and dependent buys follow.
//   • Unfunded legs (rejected spot): dependent buy is absent from
//     placeOrder calls entirely — no equity submission slips through.
//   • Base-currency buys and sells are unaffected by FX outcomes.

import { describe, it, expect } from "vitest";
import {
  trimBuysToBudgetByCurrency,
  type FxResolver,
  type MultiCcyBudgetOrder,
} from "@/lib/pre-place-budget-multi-ccy";
import {
  survivingBuysAfterFxSpot,
  type FxSpotOutcome,
} from "@/lib/fx-spot-plan";

const RATES: Record<string, number> = {
  GBPUSD: 1.25, USDGBP: 1 / 1.25,
  GBPEUR: 1.15, EURGBP: 1 / 1.15,
  USDEUR: 1.15 / 1.25, EURUSD: 1.25 / 1.15,
};
const fx: FxResolver = (from, to) =>
  from === to ? 1 : (RATES[`${from}${to}`] ?? null);

type SpotArgs = { fromCcy: string; toCcy: string; amountFrom: number; clientOrderId: string };
type SpotResult = { status: "submitted" | "filled" | "rejected"; fillRate?: number; amountTo?: number; reason?: string };
type OrderArgs = { symbol: string; side: "buy" | "sell"; quantity: number; clientOrderId: string };
type OrderResult = { status: "filled" | "rejected"; brokerOrderId?: string; reason?: string };

type BrokerCall =
  | { kind: "fx"; args: SpotArgs }
  | { kind: "order"; args: OrderArgs };

function makeAdapter(opts: {
  spot: (a: SpotArgs) => SpotResult;
  order?: (a: OrderArgs) => OrderResult;
}) {
  const timeline: BrokerCall[] = [];
  return {
    timeline,
    placeFxSpot: async (args: SpotArgs): Promise<SpotResult> => {
      timeline.push({ kind: "fx", args });
      return opts.spot(args);
    },
    placeOrder: async (args: OrderArgs): Promise<OrderResult> => {
      timeline.push({ kind: "order", args });
      return (opts.order ?? (() => ({ status: "filled", brokerOrderId: "eq-ok" })))(args);
    },
  };
}

// Compose Phase B/C + equity submission, matching the executor.
async function routeAndPlace(opts: {
  buys: MultiCcyBudgetOrder[];
  sells?: MultiCcyBudgetOrder[];
  wallet: Record<string, number>;
  baseCcy: string;
  decisionId: string;
  adapter: ReturnType<typeof makeAdapter>;
}) {
  const { buys, sells = [], wallet, baseCcy, decisionId, adapter } = opts;

  let trim = trimBuysToBudgetByCurrency(buys, wallet, baseCcy, fx, {
    safetyBufferPct: 0,
    allowFxConversion: true,
  });

  const preSkips = new Map<string, string>();
  if (trim.fxLegs.length > 0) {
    const outcomes: FxSpotOutcome[] = [];
    for (const leg of trim.fxLegs) {
      const spot = await adapter.placeFxSpot({
        fromCcy: leg.fromCcy,
        toCcy: leg.toCcy,
        amountFrom: leg.amountFrom,
        clientOrderId: `fx-${decisionId}-${leg.triggeredBySymbol}-${leg.fromCcy}${leg.toCcy}`,
      });
      const ok = spot.status === "submitted" || spot.status === "filled";
      outcomes.push(ok
        ? { kind: "ok", triggerSymbol: leg.triggeredBySymbol, fillRate: spot.fillRate ?? leg.rate, amountTo: spot.amountTo ?? leg.amountTo }
        : { kind: "failed", triggerSymbol: leg.triggeredBySymbol, reason: spot.reason ?? "fx spot rejected" });
    }
    const { survivors, droppedSymbols } = survivingBuysAfterFxSpot(buys, trim, outcomes);
    if (droppedSymbols.size > 0) {
      trim = trimBuysToBudgetByCurrency(survivors, wallet, baseCcy, fx, {
        safetyBufferPct: 0, allowFxConversion: true,
      });
      for (const [sym, reason] of droppedSymbols) preSkips.set(`${sym}:buy`, `fx spot failed: ${reason}`);
    }
  }

  // Sells route regardless of FX state.
  for (const s of sells) {
    await adapter.placeOrder({
      symbol: s.symbol, side: "sell", quantity: s.quantity,
      clientOrderId: `eq-${decisionId}-${s.symbol}-sell`,
    });
  }
  // Only allowed, non-pre-skipped buys reach the broker.
  for (const d of trim.decisions) {
    if (d.kind !== "allow") continue;
    if (preSkips.has(`${d.order.symbol}:buy`)) continue;
    await adapter.placeOrder({
      symbol: d.order.symbol, side: "buy", quantity: d.order.quantity,
      clientOrderId: `eq-${decisionId}-${d.order.symbol}-buy`,
    });
  }

  return { trim, preSkips };
}

describe("dependent multi-ccy buys — FX legs first, unfunded legs never reach the broker", () => {
  it("submits every FX leg before any dependent equity buy", async () => {
    const adapter = makeAdapter({ spot: () => ({ status: "filled" }) });
    await routeAndPlace({
      buys: [
        { symbol: "AAPL", side: "buy", quantity: 10, price: 100, instrument_ccy: "USD" }, // needs USD FX
        { symbol: "SAP",  side: "buy", quantity: 10, price: 50,  instrument_ccy: "EUR" }, // needs EUR FX
        { symbol: "VOD.L",side: "buy", quantity: 10, price: 20,  instrument_ccy: "GBP" }, // base, no FX
      ],
      wallet: { GBP: 5000, USD: 0, EUR: 0 },
      baseCcy: "GBP",
      decisionId: "dep-1",
      adapter,
    });

    const kinds = adapter.timeline.map((c) => c.kind);
    const lastFx = kinds.lastIndexOf("fx");
    const firstOrder = kinds.indexOf("order");
    expect(lastFx).toBeGreaterThanOrEqual(0);
    expect(firstOrder).toBeGreaterThan(lastFx); // every fx precedes every order

    const orderSymbols = adapter.timeline
      .filter((c): c is Extract<BrokerCall, { kind: "order" }> => c.kind === "order")
      .map((c) => c.args.symbol)
      .sort();
    expect(orderSymbols).toEqual(["AAPL", "SAP", "VOD.L"]);
  });

  it("dependent buy never reaches the broker when its FX leg is rejected", async () => {
    const adapter = makeAdapter({
      spot: (a) => a.toCcy === "USD"
        ? { status: "rejected", reason: "InsufficientCollateral" }
        : { status: "filled" },
    });
    const { preSkips } = await routeAndPlace({
      buys: [
        { symbol: "AAPL", side: "buy", quantity: 10, price: 100, instrument_ccy: "USD" },
        { symbol: "SAP",  side: "buy", quantity: 10, price: 50,  instrument_ccy: "EUR" },
        { symbol: "VOD.L",side: "buy", quantity: 10, price: 20,  instrument_ccy: "GBP" },
      ],
      wallet: { GBP: 5000, USD: 0, EUR: 0 },
      baseCcy: "GBP",
      decisionId: "dep-2",
      adapter,
    });

    const orderCalls = adapter.timeline.filter(
      (c): c is Extract<BrokerCall, { kind: "order" }> => c.kind === "order",
    );
    const orderedSymbols = orderCalls.map((c) => c.args.symbol);
    expect(orderedSymbols).not.toContain("AAPL");           // unfunded buy dropped
    expect(orderedSymbols.sort()).toEqual(["SAP", "VOD.L"]); // funded + base still submit
    expect(preSkips.get("AAPL:buy")).toMatch(/fx spot failed: InsufficientCollateral/);

    // No successful USD FX leg preceded the dropped buy.
    const usdFx = adapter.timeline.find(
      (c) => c.kind === "fx" && c.args.toCcy === "USD",
    );
    expect(usdFx).toBeDefined(); // attempt was made
    // ...but no AAPL order followed it.
    expect(orderCalls.some((c) => c.args.symbol === "AAPL")).toBe(false);
  });

  it("never places FX legs or dependent buys when base wallet cannot fund the conversion", async () => {
    const adapter = makeAdapter({ spot: () => ({ status: "filled" }) });
    const { trim } = await routeAndPlace({
      buys: [
        { symbol: "AAPL", side: "buy", quantity: 100, price: 100, instrument_ccy: "USD" }, // needs 8000 GBP
      ],
      wallet: { GBP: 100, USD: 0 },
      baseCcy: "GBP",
      decisionId: "dep-3",
      adapter,
    });
    expect(adapter.timeline).toEqual([]); // no fx, no equity — nothing reached broker
    expect(trim.decisions[0].kind).toBe("skip");
  });

  it("mixed batch: sells still submit even when a dependent buy's FX leg fails", async () => {
    const adapter = makeAdapter({
      spot: () => ({ status: "rejected", reason: "MarketClosed" }),
    });
    await routeAndPlace({
      buys: [
        { symbol: "AAPL", side: "buy", quantity: 10, price: 100, instrument_ccy: "USD" },
      ],
      sells: [
        { symbol: "TSCO.L", side: "sell", quantity: 5, price: 200, instrument_ccy: "GBP" },
      ],
      wallet: { GBP: 5000, USD: 0 },
      baseCcy: "GBP",
      decisionId: "dep-4",
      adapter,
    });

    const orderCalls = adapter.timeline.filter(
      (c): c is Extract<BrokerCall, { kind: "order" }> => c.kind === "order",
    );
    expect(orderCalls.map((c) => `${c.args.symbol}:${c.args.side}`)).toEqual([
      "TSCO.L:sell",
    ]);
    // The FX attempt happened and failed; AAPL buy must not have followed.
    expect(adapter.timeline[0].kind).toBe("fx");
    expect(orderCalls.some((c) => c.args.symbol === "AAPL")).toBe(false);
  });

  it("partial funding: only the buy whose FX leg succeeded reaches the broker", async () => {
    const adapter = makeAdapter({
      spot: (a) => a.toCcy === "EUR"
        ? { status: "filled" }
        : { status: "rejected", reason: "NoLiquidity" },
    });
    await routeAndPlace({
      buys: [
        { symbol: "AAPL", side: "buy", quantity: 10, price: 100, instrument_ccy: "USD" },
        { symbol: "SAP",  side: "buy", quantity: 10, price: 50,  instrument_ccy: "EUR" },
      ],
      wallet: { GBP: 5000, USD: 0, EUR: 0 },
      baseCcy: "GBP",
      decisionId: "dep-5",
      adapter,
    });

    const orderSymbols = adapter.timeline
      .filter((c): c is Extract<BrokerCall, { kind: "order" }> => c.kind === "order")
      .map((c) => c.args.symbol);
    expect(orderSymbols).toEqual(["SAP"]);

    // AAPL's failed USD leg was attempted, but no AAPL order followed.
    const fxCalls = adapter.timeline.filter(
      (c): c is Extract<BrokerCall, { kind: "fx" }> => c.kind === "fx",
    );
    expect(fxCalls.map((c) => c.args.toCcy).sort()).toEqual(["EUR", "USD"]);
  });
});
