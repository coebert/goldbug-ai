// End-to-end test: FX-matrix guard blocks prevent cross-currency buys from
// routing AND scrub any FX_LEG rows for the blocked pairs out of the broker
// payload.
//
// Composes the same pre-trade pipeline the live executor runs
// (`src/lib/live-executor.server.ts`, buys branch) without touching Supabase
// or the Saxo HTTP client:
//
//   1. guardFxMatrix       → mark base->ccy pairs as blocked
//                             (missing / identity_fallback / stale)
//   2. pre-skip filter     → drop buys whose instrument_ccy is blocked
//   3. trimBuysToBudget…   → route only the survivors, emit FX legs
//   4. simulate spot legs  → make sure no adapter call targets a blocked pair
//
// The assertions lock in the executor's contract with the FX health card,
// audit log, and wallet reconciliation:
//
//   - one PRE_PLACE_FX_MATRIX_BLOCK audit row per blocked pair
//   - one PRE_PLACE_SKIP row per buy whose currency was blocked
//   - the broker payload's FX_LEG rows contain NO entry for a blocked pair
//   - unblocked buys still route with their FX legs and correct wallet math

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

type LoggedFxLeg = {
  method: "FX_LEG";
  path: string;
  fromCcy: string;
  toCcy: string;
  amountFrom: number;
  amountTo: number;
  rate: number;
  triggeredBySymbol: string;
};

type LoggedFxBlock = {
  method: "PRE_PLACE_FX_MATRIX_BLOCK";
  path: string;
  status: 424;
  reason: "missing" | "identity_fallback" | "stale";
  from: string;
  to: string;
};

type LoggedPreSkip = {
  method: "PRE_PLACE_SKIP";
  symbol: string;
  reason: string;
};

type SpotArgs = { fromCcy: string; toCcy: string; amountFrom: number };

// Executor Phase-B/C pipeline reproduced end-to-end. Returns exactly the
// audit rows and broker payload the live executor would produce.
function routeWithMatrixGuard(opts: {
  buys: MultiCcyBudgetOrder[];
  wallet: Record<string, number>;
  baseCcy: string;
  matrix: FxMatrixLike;
  fx: FxResolver;
}) {
  const { buys, wallet, baseCcy, matrix, fx } = opts;

  const requiredCcys = Array.from(
    new Set(buys.map((b) => (b.instrument_ccy ?? baseCcy).toUpperCase())),
  ).filter((c) => c !== baseCcy);

  const guard = guardFxMatrix(baseCcy, requiredCcys, matrix);

  const fxBlockRows: LoggedFxBlock[] = guard.blocked.map((b) => ({
    method: "PRE_PLACE_FX_MATRIX_BLOCK",
    path: `/fx/${b.from}->${b.to}`,
    status: 424,
    reason: b.reason,
    from: b.from,
    to: b.to,
  }));

  const preSkipRows: LoggedPreSkip[] = [];
  const survivors: MultiCcyBudgetOrder[] = [];
  for (const o of buys) {
    const ccy = (o.instrument_ccy ?? baseCcy).toUpperCase();
    if (guard.blockedCcys.has(ccy)) {
      const detail =
        guard.blocked.find((x) => x.to === ccy)?.detail ??
        `fx ${baseCcy}->${ccy} blocked`;
      preSkipRows.push({
        method: "PRE_PLACE_SKIP",
        symbol: o.symbol,
        reason: detail,
      });
      continue;
    }
    survivors.push(o);
  }

  const trim = trimBuysToBudgetByCurrency(survivors, wallet, baseCcy, fx, {
    safetyBufferPct: 0,
    allowFxConversion: true,
    isRateStale: (f, t) => matrix.get(`${f}${t}`)?.stale === true,
  });

  const fxLegRows: LoggedFxLeg[] = trim.fxLegs.map((leg) => ({
    method: "FX_LEG",
    path: `/fx/${leg.fromCcy}->${leg.toCcy}`,
    fromCcy: leg.fromCcy,
    toCcy: leg.toCcy,
    amountFrom: leg.amountFrom,
    amountTo: leg.amountTo,
    rate: leg.rate,
    triggeredBySymbol: leg.triggeredBySymbol,
  }));

  // Simulate what the executor hands the adapter (spot mode): one call per
  // surviving FX leg. Blocked legs must never appear here.
  const spotCalls: SpotArgs[] = trim.fxLegs.map((leg) => ({
    fromCcy: leg.fromCcy,
    toCcy: leg.toCcy,
    amountFrom: leg.amountFrom,
  }));

  return { guard, fxBlockRows, preSkipRows, fxLegRows, spotCalls, trim };
}

// Live-rate lookup mirrored from the matrix used in each case.
function fxFromMatrix(matrix: FxMatrixLike): FxResolver {
  return (from, to) => {
    if (from === to) return 1;
    const hit = matrix.get(`${from}${to}`);
    if (!hit) return null;
    // Identity-fallback rate=1 is unusable at trim time — same rule the
    // executor applies in its inline resolver.
    if (hit.source.startsWith("fallback:")) return null;
    return hit.rate;
  };
}

function makeMatrix(
  entries: Record<string, FxMatrixEntry>,
): FxMatrixLike {
  const m = new Map(Object.entries(entries));
  return { get: (k) => m.get(k) };
}

describe("FX-matrix guard → broker payload (executor pre-trade)", () => {
  it("identity-fallback pair blocks its buys and emits no FX_LEG for that pair", async () => {
    // GBP->USD healthy; GBP->EUR both providers down → identity fallback.
    const matrix = makeMatrix({
      GBPUSD: { rate: 1.25, stale: false, source: "yahoo" },
      GBPEUR: { rate: 1, stale: true, source: "fallback:yahoo(500)+frankfurter(500)" },
    });
    const { fxBlockRows, preSkipRows, fxLegRows, spotCalls, trim } =
      routeWithMatrixGuard({
        buys: [
          // USD short → needs GBP->USD FX (healthy, should route).
          { symbol: "AAPL", side: "buy", quantity: 10, price: 100, instrument_ccy: "USD" },
          // EUR short → needs GBP->EUR (blocked, should be skipped).
          { symbol: "SAP", side: "buy", quantity: 10, price: 50, instrument_ccy: "EUR" },
        ],
        wallet: { GBP: 5000, USD: 0, EUR: 0 },
        baseCcy: "GBP",
        matrix,
        fx: fxFromMatrix(matrix),
      });

    // Exactly one audit-log block row, for GBP->EUR only.
    expect(fxBlockRows).toEqual([
      {
        method: "PRE_PLACE_FX_MATRIX_BLOCK",
        path: "/fx/GBP->EUR",
        status: 424,
        reason: "identity_fallback",
        from: "GBP",
        to: "EUR",
      },
    ]);
    // SAP was pre-skipped with the guard's reason; AAPL survives to the trim.
    expect(preSkipRows).toHaveLength(1);
    expect(preSkipRows[0].symbol).toBe("SAP");
    expect(preSkipRows[0].reason).toMatch(/identity fallback/);

    // Broker payload contains ONE FX_LEG row — for the healthy pair only.
    expect(fxLegRows.map((r) => r.path)).toEqual(["/fx/GBP->USD"]);
    expect(fxLegRows[0].triggeredBySymbol).toBe("AAPL");
    expect(spotCalls.map((c) => `${c.fromCcy}${c.toCcy}`)).toEqual(["GBPUSD"]);
    // Wallet math on the survivor is unaffected by the blocked pair.
    expect(trim.decisions.map((d) => d.kind)).toEqual(["allow"]);
    expect(trim.finalWallet.GBP).toBeCloseTo(5000 - 1000 / 1.25, 6);
    expect(trim.finalWallet.USD).toBeCloseTo(0, 6);
  });

  it("missing matrix entry blocks the buy and no adapter FX call is made", async () => {
    // GBP->USD absent from the matrix (provider outage on that pair).
    const matrix = makeMatrix({});
    const { fxBlockRows, fxLegRows, spotCalls, preSkipRows, trim } =
      routeWithMatrixGuard({
        buys: [
          { symbol: "AAPL", side: "buy", quantity: 10, price: 100, instrument_ccy: "USD" },
        ],
        wallet: { GBP: 5000, USD: 0 },
        baseCcy: "GBP",
        matrix,
        fx: fxFromMatrix(matrix),
      });
    expect(fxBlockRows).toHaveLength(1);
    expect(fxBlockRows[0]).toMatchObject({ reason: "missing", to: "USD" });
    expect(fxLegRows).toEqual([]);
    expect(spotCalls).toEqual([]);
    expect(preSkipRows[0].reason).toMatch(/missing from matrix/);
    // Trim ran over zero survivors → nothing routed.
    expect(trim.decisions).toEqual([]);
    expect(trim.finalWallet.GBP).toBe(5000);
  });

  it("stale pair blocks its buy while a healthy pair still emits its FX_LEG", async () => {
    // GBP->USD stale (cache-stale after providers failed); GBP->EUR healthy.
    const matrix = makeMatrix({
      GBPUSD: { rate: 1.25, stale: true, source: "cache-stale" },
      GBPEUR: { rate: 1.15, stale: false, source: "yahoo" },
    });
    const { fxBlockRows, fxLegRows, spotCalls } = routeWithMatrixGuard({
      buys: [
        { symbol: "AAPL", side: "buy", quantity: 10, price: 100, instrument_ccy: "USD" },
        { symbol: "SAP", side: "buy", quantity: 10, price: 50, instrument_ccy: "EUR" },
      ],
      wallet: { GBP: 5000, USD: 0, EUR: 0 },
      baseCcy: "GBP",
      matrix,
      fx: fxFromMatrix(matrix),
    });
    expect(fxBlockRows.map((r) => `${r.to}:${r.reason}`)).toEqual([
      "USD:stale",
    ]);
    // Payload has ONE FX_LEG row and it is NOT the blocked pair.
    expect(fxLegRows).toHaveLength(1);
    expect(fxLegRows[0].path).toBe("/fx/GBP->EUR");
    expect(fxLegRows.some((r) => r.toCcy === "USD")).toBe(false);
    expect(spotCalls.some((c) => c.toCcy === "USD")).toBe(false);
  });

  it("base-currency-only buys still route when every foreign pair is blocked", async () => {
    // All foreign pairs down; the GBP buy needs no FX and must not be
    // collateral damage of the block.
    const matrix = makeMatrix({
      GBPUSD: { rate: 1, stale: true, source: "fallback:yahoo(500)+frankfurter(500)" },
    });
    const { fxBlockRows, fxLegRows, spotCalls, preSkipRows, trim } =
      routeWithMatrixGuard({
        buys: [
          { symbol: "AAPL", side: "buy", quantity: 10, price: 100, instrument_ccy: "USD" },
          { symbol: "VOD.L", side: "buy", quantity: 10, price: 100, instrument_ccy: "GBP" },
        ],
        wallet: { GBP: 5000, USD: 0 },
        baseCcy: "GBP",
        matrix,
        fx: fxFromMatrix(matrix),
      });
    expect(fxBlockRows).toHaveLength(1);
    expect(fxLegRows).toEqual([]);
    expect(spotCalls).toEqual([]);
    expect(preSkipRows.map((r) => r.symbol)).toEqual(["AAPL"]);
    expect(trim.decisions).toHaveLength(1);
    expect(trim.decisions[0].order.symbol).toBe("VOD.L");
    expect(trim.decisions[0].kind).toBe("allow");
    expect(trim.finalWallet.GBP).toBeCloseTo(4000, 6);
  });
});
