// End-to-end test for multi-currency routing.
//
// Composes the same pipeline the live executor runs
// (`src/lib/live-executor.server.ts`, Phase B/C branch) without touching
// Supabase or the Saxo HTTP client:
//
//   1. trimBuysToBudgetByCurrency  → per-currency wallet routing + FX legs
//   2. adapter.placeFxSpot         → spot-mode broker FX submission
//   3. survivingBuysAfterFxSpot    → drop buys whose FX leg failed
//   4. re-trim over survivors      → wallet math for actual placement
//
// Then it asserts:
//   - the exact FX_LEG payload rows the executor would insert into
//     live_broker_log (one per surviving FX leg, with fromCcy/toCcy/amount/rate)
//   - the per-currency affordability outcomes (allow / skip + reason)
//   - the final per-currency wallet after all legs settle
//   - the client_order_id passed to placeFxSpot matches the executor's
//     `fx-<decisionId>-<sym>-<from><to>` shape
//
// This is the contract the executor relies on — if any of these change,
// the FX health card + audit log + wallet reconciliation all break.

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

// Mirrors the executor's `FX_LEG` row body (only the fields the UI + audit
// log actually read back — status is derived from `stale`).
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

// 1 GBP = 1.25 USD = 1.15 EUR. Cross rates computed.
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

// Minimal SaxoAdapter-shape stub matching what live-executor invokes.
type SpotArgs = {
  fromCcy: string;
  toCcy: string;
  amountFrom: number;
  clientOrderId: string;
};
type SpotResult = {
  status: "submitted" | "filled" | "rejected";
  brokerOrderId?: string;
  pairSymbol?: string;
  fillRate?: number;
  amountTo?: number;
  reason?: string;
};

function makeAdapter(behaviour: (a: SpotArgs) => SpotResult) {
  const calls: SpotArgs[] = [];
  return {
    calls,
    placeFxSpot: async (args: SpotArgs): Promise<SpotResult> => {
      calls.push(args);
      return behaviour(args);
    },
  };
}

// Reproduce the executor's Phase B/C compose (the exact sequence in
// `src/lib/live-executor.server.ts` between the `fxExecutionMode === 'spot'`
// branch and the `PRE_PLACE_MULTI_CCY_TRIM` log). Returns the FX_LEG
// payload rows and final trim result.
async function routeMultiCcy(opts: {
  buys: MultiCcyBudgetOrder[];
  wallet: Record<string, number>;
  baseCcy: string;
  decisionId: string;
  adapter: ReturnType<typeof makeAdapter>;
  safetyBufferPct?: number;
}) {
  const { buys, wallet, baseCcy, decisionId, adapter, safetyBufferPct = 0 } =
    opts;

  let trim = trimBuysToBudgetByCurrency(buys, wallet, baseCcy, fx, {
    safetyBufferPct,
    allowFxConversion: true,
  });

  const preSkips = new Map<string, string>();
  if (trim.fxLegs.length > 0) {
    const outcomes: FxSpotOutcome[] = [];
    for (const leg of trim.fxLegs) {
      const clientOrderId = `fx-${decisionId}-${leg.triggeredBySymbol}-${leg.fromCcy}${leg.toCcy}`;
      const spot = await adapter.placeFxSpot({
        fromCcy: leg.fromCcy,
        toCcy: leg.toCcy,
        amountFrom: leg.amountFrom,
        clientOrderId,
      });
      const ok = spot.status === "submitted" || spot.status === "filled";
      outcomes.push(
        ok
          ? {
              kind: "ok",
              triggerSymbol: leg.triggeredBySymbol,
              fillRate: spot.fillRate ?? leg.rate,
              amountTo: spot.amountTo ?? leg.amountTo,
            }
          : {
              kind: "failed",
              triggerSymbol: leg.triggeredBySymbol,
              reason: spot.reason ?? "fx spot rejected",
            },
      );
    }
    const { survivors, droppedSymbols } = survivingBuysAfterFxSpot(
      buys,
      trim,
      outcomes,
    );
    if (droppedSymbols.size > 0) {
      trim = trimBuysToBudgetByCurrency(survivors, wallet, baseCcy, fx, {
        safetyBufferPct,
        allowFxConversion: true,
      });
      for (const [sym, reason] of droppedSymbols) {
        preSkips.set(`${sym}:buy`, `fx spot failed: ${reason}`);
      }
    }
  }

  const fxLegRows: LoggedFxLeg[] = trim.fxLegs.map((leg) => ({
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

  return { trim, fxLegRows, preSkips };
}

describe("multi-currency routing → broker payload (executor Phase B/C)", () => {
  it("emits one FX_LEG row per short-currency buy with executor-shaped payload", async () => {
    const adapter = makeAdapter(() => ({
      status: "filled",
      brokerOrderId: "sim-fx-1",
    }));
    const { trim, fxLegRows } = await routeMultiCcy({
      // USD short (needs 1000, has 200) + EUR fully funded from wallet.
      buys: [
        { symbol: "AAPL", side: "buy", quantity: 10, price: 100, instrument_ccy: "USD" },
        { symbol: "VOD.L", side: "buy", quantity: 10, price: 50, instrument_ccy: "EUR" },
      ],
      wallet: { GBP: 5000, USD: 200, EUR: 600 },
      baseCcy: "GBP",
      decisionId: "dec-1",
      adapter,
    });

    // Per-currency outcomes: both allowed.
    expect(trim.decisions.map((d) => d.kind)).toEqual(["allow", "allow"]);
    // Exactly one FX leg, targeting the short currency only.
    expect(fxLegRows).toHaveLength(1);
    expect(fxLegRows[0]).toMatchObject({
      method: "FX_LEG",
      path: "/fx/GBP->USD",
      status: 200,
      fromCcy: "GBP",
      toCcy: "USD",
      triggeredBySymbol: "AAPL",
      stale: false,
    });
    expect(fxLegRows[0].amountTo).toBeCloseTo(800, 6); // 1000 needed − 200 held
    expect(fxLegRows[0].amountFrom).toBeCloseTo(640, 6); // 800 / 1.25
    expect(fxLegRows[0].amountFrom * fxLegRows[0].rate).toBeCloseTo(
      fxLegRows[0].amountTo,
      6,
    );
    // Final wallet: GBP 5000 − 640 = 4360; USD 200 + 800 − 1000 = 0; EUR spent 500.
    expect(trim.finalWallet.GBP).toBeCloseTo(4360, 6);
    expect(trim.finalWallet.USD).toBeCloseTo(0, 6);
    expect(trim.finalWallet.EUR).toBeCloseTo(100, 6);

    // Executor's spot client_order_id shape.
    expect(adapter.calls[0].clientOrderId).toBe("fx-dec-1-AAPL-GBPUSD");
  });

  it("stale FX leg is logged with status=206 while the buy still routes", async () => {
    const adapter = makeAdapter(() => ({ status: "filled" }));
    let trim = trimBuysToBudgetByCurrency(
      [{ symbol: "AAPL", side: "buy", quantity: 10, price: 100, instrument_ccy: "USD" }],
      { GBP: 5000, USD: 0 },
      "GBP",
      fx,
      {
        safetyBufferPct: 0,
        allowFxConversion: true,
        isRateStale: (f, t) => f === "GBP" && t === "USD",
      },
    );
    // Simulate the executor's log-row shape directly (routeMultiCcy uses
    // the default resolver; this test wires isRateStale explicitly).
    void adapter; // stale path never reaches spot placement here.
    const row = {
      status: trim.fxLegs[0].stale ? 206 : 200,
      stale: trim.fxLegs[0].stale,
    };
    expect(row.stale).toBe(true);
    expect(row.status).toBe(206);
    expect(trim.decisions[0].kind).toBe("allow");
  });

  it("failed FX spot removes the funded buy and re-trim omits its FX_LEG row", async () => {
    const adapter = makeAdapter((a) =>
      a.toCcy === "USD"
        ? { status: "rejected", reason: "InsufficientCollateral" }
        : { status: "filled" },
    );
    const { trim, fxLegRows, preSkips } = await routeMultiCcy({
      // AAPL (USD, needs FX) + VOD.L (GBP, no FX). USD FX rejected.
      buys: [
        { symbol: "AAPL", side: "buy", quantity: 10, price: 100, instrument_ccy: "USD" },
        { symbol: "VOD.L", side: "buy", quantity: 10, price: 100, instrument_ccy: "GBP" },
      ],
      wallet: { GBP: 5000, USD: 0 },
      baseCcy: "GBP",
      decisionId: "dec-2",
      adapter,
    });

    // AAPL was dropped by fx-spot failure → re-trim leaves no FX legs.
    expect(fxLegRows).toEqual([]);
    // Re-trimmed survivors: only the GBP buy remains, and it's allowed.
    expect(trim.decisions).toHaveLength(1);
    expect(trim.decisions[0].order.symbol).toBe("VOD.L");
    expect(trim.decisions[0].kind).toBe("allow");
    // Executor-side pre-skip carries the FX failure reason back to routing.
    expect(preSkips.get("AAPL:buy")).toMatch(/fx spot failed: InsufficientCollateral/);
    // Wallet reflects only the GBP debit.
    expect(trim.finalWallet.GBP).toBeCloseTo(4000, 6);
    expect(trim.finalWallet.USD ?? 0).toBe(0);
  });

  it("per-currency skip when base wallet cannot fund the FX conversion", async () => {
    const adapter = makeAdapter(() => ({ status: "filled" }));
    const { trim, fxLegRows } = await routeMultiCcy({
      // Needs 10,000 USD → 8,000 GBP FX; only 100 GBP available.
      buys: [
        { symbol: "AAPL", side: "buy", quantity: 100, price: 100, instrument_ccy: "USD" },
      ],
      wallet: { GBP: 100, USD: 0 },
      baseCcy: "GBP",
      decisionId: "dec-3",
      adapter,
    });
    expect(fxLegRows).toEqual([]);
    expect(adapter.calls).toEqual([]); // never reached spot placement
    const d = trim.decisions[0];
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") {
      expect(d.reason).toMatch(/insufficient GBP to convert/);
    }
    expect(trim.finalWallet.GBP).toBe(100);
  });

  it("routes multiple short currencies as independent FX legs (USD + EUR)", async () => {
    const adapter = makeAdapter(() => ({ status: "filled" }));
    const { fxLegRows, trim } = await routeMultiCcy({
      buys: [
        { symbol: "AAPL", side: "buy", quantity: 10, price: 100, instrument_ccy: "USD" }, // 1000 USD
        { symbol: "SAP", side: "buy", quantity: 10, price: 50, instrument_ccy: "EUR" },   // 500 EUR
      ],
      wallet: { GBP: 5000, USD: 0, EUR: 0 },
      baseCcy: "GBP",
      decisionId: "dec-4",
      adapter,
    });

    const paths = fxLegRows.map((r) => r.path).sort();
    expect(paths).toEqual(["/fx/GBP->EUR", "/fx/GBP->USD"]);
    expect(trim.decisions.map((d) => d.kind)).toEqual(["allow", "allow"]);
    // Each leg funds its own currency exactly.
    for (const row of fxLegRows) {
      expect(row.amountFrom * row.rate).toBeCloseTo(row.amountTo, 6);
    }
    // Both spot legs submitted with executor client_order_id shape.
    const ids = adapter.calls.map((c) => c.clientOrderId).sort();
    expect(ids).toEqual(["fx-dec-4-AAPL-GBPUSD", "fx-dec-4-SAP-GBPEUR"]);
  });
});
