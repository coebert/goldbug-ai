// End-to-end: a partial batch (sells + cross-currency buys where the
// FX-matrix guard blocks some pairs) must produce FX_LEG rows ONLY for the
// allowed portions of the batch.
//
// Executor contract this locks in:
//   • Sells never emit an FX_LEG row (they generate currency, not consume it).
//     Sells must route regardless of any FX-matrix block affecting buys.
//   • Buys whose target currency is blocked by the matrix guard
//     (missing / identity_fallback / stale) are pre-skipped and their
//     FX_LEG row is scrubbed from the payload.
//   • Buys whose target currency is healthy still produce their FX_LEG row
//     with correct amounts, and the adapter is only asked to place spot
//     legs for those allowed pairs.
//
// Composes the same pre-trade pipeline as the live executor
// (`src/lib/live-executor.server.ts`, buys branch under fxExecutionMode='spot').

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
  status: 200 | 206;
  fromCcy: string;
  toCcy: string;
  amountFrom: number;
  amountTo: number;
  triggeredBySymbol: string;
};

type PreSkipRow = { method: "PRE_PLACE_SKIP"; symbol: string; reason: string };

type SpotArgs = { fromCcy: string; toCcy: string; amountFrom: number; clientOrderId: string };
type OrderArgs = { symbol: string; side: "buy" | "sell"; quantity: number; clientOrderId: string };
type BrokerCall = { kind: "fx"; args: SpotArgs } | { kind: "order"; args: OrderArgs };

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

function routePartialBatch(opts: {
  buys: MultiCcyBudgetOrder[];
  sells: MultiCcyBudgetOrder[];
  wallet: Record<string, number>;
  baseCcy: string;
  matrix: FxMatrixLike;
  decisionId: string;
}) {
  const { buys, sells, wallet, baseCcy, matrix, decisionId } = opts;

  const requiredCcys = Array.from(
    new Set(buys.map((b) => (b.instrument_ccy ?? baseCcy).toUpperCase())),
  ).filter((c) => c !== baseCcy);
  const guard = guardFxMatrix(baseCcy, requiredCcys, matrix);

  const preSkipRows: PreSkipRow[] = [];
  const survivors: MultiCcyBudgetOrder[] = [];
  for (const o of buys) {
    const ccy = (o.instrument_ccy ?? baseCcy).toUpperCase();
    if (guard.blockedCcys.has(ccy)) {
      const detail =
        guard.blocked.find((x) => x.to === ccy)?.detail ??
        `fx ${baseCcy}->${ccy} blocked`;
      preSkipRows.push({ method: "PRE_PLACE_SKIP", symbol: o.symbol, reason: detail });
      continue;
    }
    survivors.push(o);
  }

  const trim = trimBuysToBudgetByCurrency(survivors, wallet, baseCcy, fxFromMatrix(matrix), {
    safetyBufferPct: 0,
    allowFxConversion: true,
    isRateStale: (f, t) => matrix.get(`${f}${t}`)?.stale === true,
  });

  const fxLegRows: FxLegRow[] = trim.fxLegs.map((leg) => ({
    method: "FX_LEG",
    path: `/fx/${leg.fromCcy}->${leg.toCcy}`,
    status: leg.stale ? 206 : 200,
    fromCcy: leg.fromCcy,
    toCcy: leg.toCcy,
    amountFrom: leg.amountFrom,
    amountTo: leg.amountTo,
    triggeredBySymbol: leg.triggeredBySymbol,
  }));

  // Simulate broker submission timeline: FX legs first, then sells + allowed buys.
  const timeline: BrokerCall[] = [];
  for (const leg of trim.fxLegs) {
    timeline.push({
      kind: "fx",
      args: {
        fromCcy: leg.fromCcy,
        toCcy: leg.toCcy,
        amountFrom: leg.amountFrom,
        clientOrderId: `fx-${decisionId}-${leg.triggeredBySymbol}-${leg.fromCcy}${leg.toCcy}`,
      },
    });
  }
  for (const s of sells) {
    timeline.push({
      kind: "order",
      args: {
        symbol: s.symbol, side: "sell", quantity: s.quantity,
        clientOrderId: `eq-${decisionId}-${s.symbol}-sell`,
      },
    });
  }
  for (const d of trim.decisions) {
    if (d.kind !== "allow") continue;
    timeline.push({
      kind: "order",
      args: {
        symbol: d.order.symbol, side: "buy", quantity: d.order.quantity,
        clientOrderId: `eq-${decisionId}-${d.order.symbol}-buy`,
      },
    });
  }

  return { guard, preSkipRows, fxLegRows, timeline, trim };
}

describe("partial batch: sells + partly-blocked buys → FX_LEG only for allowed portions", () => {
  it("sells always route; FX_LEG rows appear only for the healthy buy pair", () => {
    // GBP->USD healthy; GBP->EUR identity-fallback (blocked).
    const matrix = makeMatrix({
      GBPUSD: { rate: 1.25, stale: false, source: "yahoo" },
      GBPEUR: { rate: 1, stale: true, source: "fallback:yahoo(500)+frankfurter(500)" },
    });
    const { fxLegRows, preSkipRows, timeline, guard } = routePartialBatch({
      buys: [
        { symbol: "AAPL", side: "buy", quantity: 10, price: 100, instrument_ccy: "USD" }, // allowed
        { symbol: "SAP",  side: "buy", quantity: 10, price: 50,  instrument_ccy: "EUR" }, // blocked
      ],
      sells: [
        // Foreign-ccy sell — must still route even though EUR/USD sides have blocks.
        { symbol: "TSLA",   side: "sell", quantity: 5, price: 200, instrument_ccy: "USD" },
        { symbol: "TSCO.L", side: "sell", quantity: 5, price: 300, instrument_ccy: "GBP" },
      ],
      wallet: { GBP: 5000, USD: 0, EUR: 0 },
      baseCcy: "GBP",
      matrix,
      decisionId: "part-1",
    });

    // FX_LEG rows only for the allowed buy (USD). No EUR row.
    expect(fxLegRows).toHaveLength(1);
    expect(fxLegRows[0]).toMatchObject({
      method: "FX_LEG",
      path: "/fx/GBP->USD",
      status: 200,
      triggeredBySymbol: "AAPL",
    });
    expect(fxLegRows.some((r) => r.toCcy === "EUR")).toBe(false);

    // Guard produced a single audit skip for the blocked EUR buy.
    expect(guard.blockedCcys.has("EUR")).toBe(true);
    expect(preSkipRows.map((r) => r.symbol)).toEqual(["SAP"]);

    // Broker timeline: one FX call (USD), then both sells, then allowed buy. No EUR anywhere.
    const kinds = timeline.map((c) =>
      c.kind === "fx" ? `fx:${c.args.toCcy}` : `order:${c.args.symbol}:${c.args.side}`,
    );
    expect(kinds).toEqual([
      "fx:USD",
      "order:TSLA:sell",
      "order:TSCO.L:sell",
      "order:AAPL:buy",
    ]);
    expect(kinds.some((k) => k.includes("EUR") || k === "order:SAP:buy")).toBe(false);
  });

  it("multiple blocked pairs: FX_LEG rows only for the surviving allowed pair", () => {
    // Only GBP->USD healthy. GBP->EUR missing, GBP->JPY stale.
    const matrix = makeMatrix({
      GBPUSD: { rate: 1.25, stale: false, source: "yahoo" },
      GBPJPY: { rate: 190, stale: true, source: "yahoo" }, // stale → blocked by guard
    });
    const { fxLegRows, preSkipRows, timeline } = routePartialBatch({
      buys: [
        { symbol: "AAPL", side: "buy", quantity: 10, price: 100, instrument_ccy: "USD" }, // allowed
        { symbol: "SAP",  side: "buy", quantity: 10, price: 50,  instrument_ccy: "EUR" }, // missing → blocked
        { symbol: "7203", side: "buy", quantity: 10, price: 1000, instrument_ccy: "JPY" }, // stale → blocked
      ],
      sells: [
        { symbol: "VOD.L", side: "sell", quantity: 20, price: 100, instrument_ccy: "GBP" },
      ],
      wallet: { GBP: 50000, USD: 0, EUR: 0, JPY: 0 },
      baseCcy: "GBP",
      matrix,
      decisionId: "part-2",
    });

    // Only the USD leg survives.
    expect(fxLegRows.map((r) => r.toCcy)).toEqual(["USD"]);
    expect(preSkipRows.map((r) => r.symbol).sort()).toEqual(["7203", "SAP"]);

    // Broker payload contains no FX for EUR or JPY, and no buy orders for SAP/7203.
    const fxTargets = timeline
      .filter((c): c is Extract<BrokerCall, { kind: "fx" }> => c.kind === "fx")
      .map((c) => c.args.toCcy);
    expect(fxTargets).toEqual(["USD"]);

    const orderSyms = timeline
      .filter((c): c is Extract<BrokerCall, { kind: "order" }> => c.kind === "order")
      .map((c) => `${c.args.symbol}:${c.args.side}`);
    expect(orderSyms).toEqual(["VOD.L:sell", "AAPL:buy"]);
    expect(orderSyms.some((s) => s.startsWith("SAP") || s.startsWith("7203"))).toBe(false);
  });

  it("sells-only batch with a blocked FX pair emits zero FX_LEG rows", () => {
    const matrix = makeMatrix({
      GBPUSD: { rate: 1, stale: true, source: "fallback:yahoo(500)+frankfurter(500)" },
    });
    const { fxLegRows, preSkipRows, timeline } = routePartialBatch({
      buys: [],
      sells: [
        { symbol: "TSLA",   side: "sell", quantity: 5, price: 200, instrument_ccy: "USD" },
        { symbol: "TSCO.L", side: "sell", quantity: 5, price: 300, instrument_ccy: "GBP" },
      ],
      wallet: { GBP: 1000, USD: 0 },
      baseCcy: "GBP",
      matrix,
      decisionId: "part-3",
    });

    expect(fxLegRows).toEqual([]);
    expect(preSkipRows).toEqual([]); // no buys → no pre-skips
    const kinds = timeline.map((c) =>
      c.kind === "fx" ? "fx" : `order:${c.args.symbol}:${c.args.side}`,
    );
    expect(kinds).toEqual(["order:TSLA:sell", "order:TSCO.L:sell"]);
  });
});
