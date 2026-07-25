// End-to-end: FX-matrix blocks prevent cross-currency SELLS from routing,
// and the resulting broker payload contains zero FX_LEG rows for blocked
// pairs (whether the pair was triggered by a buy or a sell).
//
// This mirrors the buy-side contract already asserted in
// `fx-matrix-guard-block-broker-payload.e2e.test.ts` but extends the
// guard to the sell side. A cross-currency sell needs an intact FX pair
// to repatriate proceeds; if the guard marks that pair as unhealthy
// (missing / identity_fallback / stale), the sell must:
//   1. never reach the broker (no placeOrder call), and
//   2. produce no FX_LEG row in the audit payload.
// A same-currency sell (base ccy) is unaffected and always routes.
//
// Composes the same pre-trade pipeline as the live executor
// (`src/lib/live-executor.server.ts`) with a symmetric sell-side guard
// applied — the assertions lock in the contract the FX health card,
// audit log, and reconciliation depend on.

import { describe, it, expect } from "vitest";
import {
  guardFxMatrix,
  type FxMatrixLike,
} from "@/lib/fx-matrix-guard";
import {
  trimBuysToBudgetByCurrency,
  type FxResolver,
  type MultiCcyBudgetOrder,
} from "@/lib/pre-place-budget-multi-ccy";

type FxMatrixEntry = { rate: number; stale: boolean; source: string };

type FxLegRow = {
  method: "FX_LEG";
  path: string;
  fromCcy: string;
  toCcy: string;
  triggeredBySymbol: string;
};

type PreSkipRow = {
  method: "PRE_PLACE_SKIP";
  symbol: string;
  side: "buy" | "sell";
  reason: string;
};

type FxBlockRow = {
  method: "PRE_PLACE_FX_MATRIX_BLOCK";
  status: 424;
  from: string;
  to: string;
  reason: "missing" | "identity_fallback" | "stale";
};

type OrderArgs = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  clientOrderId: string;
};
type SpotArgs = { fromCcy: string; toCcy: string; amountFrom: number };
type BrokerCall =
  | { kind: "fx"; args: SpotArgs }
  | { kind: "order"; args: OrderArgs };

function fxFromMatrix(matrix: FxMatrixLike): FxResolver {
  return (from, to) => {
    if (from === to) return 1;
    const hit = matrix.get(`${from}${to}`);
    if (!hit) return null;
    if (hit.source.startsWith("fallback:")) return null; // identity fallback unusable
    return hit.rate;
  };
}

function makeMatrix(entries: Record<string, FxMatrixEntry>): FxMatrixLike {
  const m = new Map(Object.entries(entries));
  return { get: (k) => m.get(k) };
}

function routeWithSellGuard(opts: {
  buys: MultiCcyBudgetOrder[];
  sells: MultiCcyBudgetOrder[];
  wallet: Record<string, number>;
  baseCcy: string;
  matrix: FxMatrixLike;
  decisionId: string;
}) {
  const { buys, sells, wallet, baseCcy, matrix, decisionId } = opts;

  // Both buys AND sells need the FX pair to repatriate / fund. Derive the
  // required-ccy set from both sides, exactly as the executor would if the
  // sell-side guard were live.
  const requiredCcys = Array.from(
    new Set(
      [...buys, ...sells]
        .map((o) => (o.instrument_ccy ?? baseCcy).toUpperCase())
        .filter((c) => c !== baseCcy),
    ),
  );
  const guard = guardFxMatrix(baseCcy, requiredCcys, matrix);

  const fxBlockRows: FxBlockRow[] = guard.blocked.map((b) => ({
    method: "PRE_PLACE_FX_MATRIX_BLOCK",
    status: 424,
    from: b.from,
    to: b.to,
    reason: b.reason,
  }));

  const preSkipRows: PreSkipRow[] = [];
  const skipReason = (ccy: string) =>
    guard.blocked.find((x) => x.to === ccy)?.detail ??
    `fx ${baseCcy}->${ccy} blocked`;

  const survivingBuys: MultiCcyBudgetOrder[] = [];
  for (const o of buys) {
    const ccy = (o.instrument_ccy ?? baseCcy).toUpperCase();
    if (guard.blockedCcys.has(ccy)) {
      preSkipRows.push({
        method: "PRE_PLACE_SKIP",
        symbol: o.symbol,
        side: "buy",
        reason: skipReason(ccy),
      });
      continue;
    }
    survivingBuys.push(o);
  }

  const survivingSells: MultiCcyBudgetOrder[] = [];
  for (const o of sells) {
    const ccy = (o.instrument_ccy ?? baseCcy).toUpperCase();
    if (guard.blockedCcys.has(ccy)) {
      preSkipRows.push({
        method: "PRE_PLACE_SKIP",
        symbol: o.symbol,
        side: "sell",
        reason: skipReason(ccy),
      });
      continue;
    }
    survivingSells.push(o);
  }

  const trim = trimBuysToBudgetByCurrency(
    survivingBuys,
    wallet,
    baseCcy,
    fxFromMatrix(matrix),
    {
      safetyBufferPct: 0,
      allowFxConversion: true,
      isRateStale: (f, t) => matrix.get(`${f}${t}`)?.stale === true,
    },
  );

  const fxLegRows: FxLegRow[] = trim.fxLegs.map((leg) => ({
    method: "FX_LEG",
    path: `/fx/${leg.fromCcy}->${leg.toCcy}`,
    fromCcy: leg.fromCcy,
    toCcy: leg.toCcy,
    triggeredBySymbol: leg.triggeredBySymbol,
  }));

  // Broker submission timeline (FX legs first, then equity orders).
  const timeline: BrokerCall[] = [];
  for (const leg of trim.fxLegs) {
    timeline.push({
      kind: "fx",
      args: {
        fromCcy: leg.fromCcy,
        toCcy: leg.toCcy,
        amountFrom: leg.amountFrom,
      },
    });
  }
  for (const s of survivingSells) {
    timeline.push({
      kind: "order",
      args: {
        symbol: s.symbol,
        side: "sell",
        quantity: s.quantity,
        clientOrderId: `eq-${decisionId}-${s.symbol}-sell`,
      },
    });
  }
  for (const d of trim.decisions) {
    if (d.kind !== "allow") continue;
    timeline.push({
      kind: "order",
      args: {
        symbol: d.order.symbol,
        side: "buy",
        quantity: d.order.quantity,
        clientOrderId: `eq-${decisionId}-${d.order.symbol}-buy`,
      },
    });
  }

  return { guard, fxBlockRows, preSkipRows, fxLegRows, timeline, trim };
}

describe("FX-matrix guard blocks cross-currency SELLS → no FX_LEG for blocked pairs", () => {
  it("identity-fallback pair blocks the cross-ccy sell and emits no FX_LEG for that pair", () => {
    const matrix = makeMatrix({
      // GBP->EUR both providers down → identity fallback (blocked).
      GBPEUR: { rate: 1, stale: true, source: "fallback:yahoo(500)+frankfurter(500)" },
    });
    const { fxBlockRows, preSkipRows, fxLegRows, timeline } =
      routeWithSellGuard({
        buys: [],
        sells: [
          { symbol: "SAP", side: "sell", quantity: 10, price: 50, instrument_ccy: "EUR" },
          { symbol: "TSCO.L", side: "sell", quantity: 5, price: 300, instrument_ccy: "GBP" },
        ],
        wallet: { GBP: 5000, EUR: 500 },
        baseCcy: "GBP",
        matrix,
        decisionId: "sell-1",
      });

    // Guard row for GBP->EUR only.
    expect(fxBlockRows).toEqual([
      { method: "PRE_PLACE_FX_MATRIX_BLOCK", status: 424, from: "GBP", to: "EUR", reason: "identity_fallback" },
    ]);
    // The EUR sell is pre-skipped; the GBP sell is not.
    expect(preSkipRows).toEqual([
      expect.objectContaining({ symbol: "SAP", side: "sell" }),
    ]);
    // No FX legs anywhere (sells don't emit FX legs, and the buy list is empty).
    expect(fxLegRows).toEqual([]);
    // Broker timeline: only the base-ccy sell reaches the adapter; SAP is absent.
    const orderRows = timeline.filter(
      (c): c is Extract<BrokerCall, { kind: "order" }> => c.kind === "order",
    );
    expect(orderRows.map((c) => `${c.args.symbol}:${c.args.side}`)).toEqual([
      "TSCO.L:sell",
    ]);
    expect(timeline.some((c) => c.kind === "fx")).toBe(false);
  });

  it("missing-rate pair blocks its sell while a healthy pair allows both sides to route", () => {
    // GBP->USD healthy, GBP->JPY missing entirely (blocked).
    const matrix = makeMatrix({
      GBPUSD: { rate: 1.25, stale: false, source: "yahoo" },
    });
    const { fxBlockRows, preSkipRows, fxLegRows, timeline } =
      routeWithSellGuard({
        buys: [
          // USD buy still routes and gets its FX_LEG.
          { symbol: "AAPL", side: "buy", quantity: 10, price: 100, instrument_ccy: "USD" },
        ],
        sells: [
          // USD sell allowed (pair healthy).
          { symbol: "TSLA", side: "sell", quantity: 5, price: 200, instrument_ccy: "USD" },
          // JPY sell blocked (pair missing).
          { symbol: "7203", side: "sell", quantity: 10, price: 1000, instrument_ccy: "JPY" },
        ],
        wallet: { GBP: 5000, USD: 200, JPY: 100000 },
        baseCcy: "GBP",
        matrix,
        decisionId: "sell-2",
      });

    // Exactly one guard block, for GBP->JPY.
    expect(fxBlockRows).toEqual([
      { method: "PRE_PLACE_FX_MATRIX_BLOCK", status: 424, from: "GBP", to: "JPY", reason: "missing" },
    ]);
    // Only the JPY sell is pre-skipped.
    expect(preSkipRows.map((r) => `${r.symbol}:${r.side}`)).toEqual([
      "7203:sell",
    ]);
    // FX_LEG rows only for the allowed USD buy — nothing for JPY.
    expect(fxLegRows.map((r) => `${r.fromCcy}->${r.toCcy}`)).toEqual([
      "GBP->USD",
    ]);
    expect(fxLegRows.some((r) => r.toCcy === "JPY")).toBe(false);
    // Broker timeline never touches JPY.
    const paths = timeline.map((c) =>
      c.kind === "fx"
        ? `fx:${c.args.fromCcy}->${c.args.toCcy}`
        : `order:${c.args.symbol}:${c.args.side}`,
    );
    expect(paths).toEqual([
      "fx:GBP->USD",
      "order:TSLA:sell",
      "order:AAPL:buy",
    ]);
    expect(paths.some((p) => p.includes("JPY") || p.includes("7203"))).toBe(false);
  });

  it("stale pair blocks its cross-ccy sell (no FX_LEG, no broker call)", () => {
    const matrix = makeMatrix({
      GBPUSD: { rate: 1.25, stale: true, source: "yahoo" }, // stale → blocked
    });
    const { fxBlockRows, preSkipRows, fxLegRows, timeline } =
      routeWithSellGuard({
        buys: [],
        sells: [
          { symbol: "TSLA", side: "sell", quantity: 5, price: 200, instrument_ccy: "USD" },
        ],
        wallet: { GBP: 5000, USD: 1000 },
        baseCcy: "GBP",
        matrix,
        decisionId: "sell-3",
      });

    expect(fxBlockRows).toEqual([
      { method: "PRE_PLACE_FX_MATRIX_BLOCK", status: 424, from: "GBP", to: "USD", reason: "stale" },
    ]);
    expect(preSkipRows).toEqual([
      expect.objectContaining({ symbol: "TSLA", side: "sell", reason: expect.stringMatching(/stale/i) }),
    ]);
    expect(fxLegRows).toEqual([]);
    expect(timeline).toEqual([]); // nothing reaches the broker
  });

  it("base-ccy sells always route even when unrelated cross-ccy pairs are blocked", () => {
    const matrix = makeMatrix({
      GBPEUR: { rate: 1, stale: true, source: "fallback:yahoo(500)+frankfurter(500)" },
    });
    const { fxLegRows, preSkipRows, timeline } = routeWithSellGuard({
      buys: [],
      sells: [
        { symbol: "TSCO.L", side: "sell", quantity: 5, price: 300, instrument_ccy: "GBP" },
        { symbol: "VOD.L",  side: "sell", quantity: 10, price: 100, instrument_ccy: "GBP" },
      ],
      wallet: { GBP: 5000 },
      baseCcy: "GBP",
      matrix,
      decisionId: "sell-4",
    });

    // No pre-skips (no cross-ccy orders), no FX legs, and both sells reach the broker.
    expect(preSkipRows).toEqual([]);
    expect(fxLegRows).toEqual([]);
    expect(
      timeline
        .filter((c): c is Extract<BrokerCall, { kind: "order" }> => c.kind === "order")
        .map((c) => `${c.args.symbol}:${c.args.side}`),
    ).toEqual(["TSCO.L:sell", "VOD.L:sell"]);
  });
});
