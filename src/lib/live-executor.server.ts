// Routes AI-executed orders to the Saxo broker adapter for live_sim / live_prod
// portfolios. Idempotent via a deterministic client_order_id keyed on
// (portfolio_id, trade_date, symbol, side). Never called for paper mode.
//
// This runs AFTER the simulator has already updated local holdings/cash, so
// the local state is a best-effort mirror and the nightly reconciliation cron
// squares it against actual broker positions.

import type { BrokerOrderResult } from "@/lib/brokers/adapter";
import { asJson } from "@/lib/_server/db-json";
import { createHash } from "node:crypto";

export interface ExecutedOrderLike {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  reason?: string;
  rejected?: string;
  /**
   * Phase B: currency the price is quoted in (e.g. "USD" for AAPL). When
   * omitted the executor resolves it from `saxo_instrument_cache` for
   * fx_enabled portfolios, and falls back to the portfolio base currency.
   */
  instrument_ccy?: string;
}


export interface RouteResult {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  status: string;
  brokerOrderId?: string;
  reason?: string;
  skipped?: string;
}

/**
 * Submit each executed order to the Saxo broker.
 * @param portfolio  the portfolio row (mode must be live_sim or live_prod)
 * @param userId     owner user id (for broker log + RLS-safe inserts)
 * @param asOf       ISO date string used in the client_order_id
 * @param decisionId decisions.id row this batch belongs to (nullable)
 * @param executed   executed[] array from trading-engine
 */
export async function routeOrdersToBroker(params: {
  portfolio: { id: string; mode: string; live_paused?: boolean | null };
  userId: string;
  asOf: string;
  decisionId: string | null;
  executed: ExecutedOrderLike[];
}): Promise<RouteResult[]> {
  const { portfolio, userId, asOf, decisionId, executed } = params;
  const results: RouteResult[] = [];

  // Post-broker reconciliation state. Populated by the buys branch so the
  // reconciler at the end of routing can verify each buy landed with the
  // FX legs the trimmer planned. Empty for sells-only / non-fx runs.
  const reconPlannedLegs: import("./post-broker-reconciliation").PlannedFxLegLite[] = [];
  const reconFxOutcomes: import("./post-broker-reconciliation").FxLegOutcome[] = [];

  if (portfolio.mode !== "live_sim" && portfolio.mode !== "live_prod") return results;
  if (portfolio.live_paused) return results;

  // Global kill-switch: when LIVE_SIM_PAPER_ONLY is truthy, live_sim portfolios
  // stay fully paper-traded and never touch the broker adapter, regardless of
  // how they're marked. live_prod is unaffected.
  const paperOnlyFlag = (process.env.LIVE_SIM_PAPER_ONLY ?? "").toLowerCase();
  const paperOnly = paperOnlyFlag === "1" || paperOnlyFlag === "true" || paperOnlyFlag === "yes";
  if (paperOnly && portfolio.mode === "live_sim") {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.from("live_broker_log").insert({
        portfolio_id: portfolio.id,
        user_id: userId,
        broker: "saxo",
        env: "sim",
        method: "ROUTE_SKIPPED_PAPER_ONLY",
        path: "/route/paper-only",
        status: 0,
        request: asJson({ asOf, decisionId, count: executed.length }),
        response: null,
        error: "LIVE_SIM_PAPER_ONLY env flag active",
      });
    } catch {
      // best-effort log only
    }
    return results;
  }



  const routable = executed.filter(
    (e) => !e.rejected && e.quantity > 0 && Number.isFinite(e.quantity) && Number.isFinite(e.price),
  );
  if (routable.length === 0) return results;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  let adapter: import("@/lib/brokers/saxo.server").SaxoAdapter;
  try {
    const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
    adapter = await buildSaxoAdapter({
      userId,
      portfolioId: portfolio.id,
      envOverride: portfolio.mode === "live_prod" ? "live" : "sim",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Adapter unavailable (missing SAXO_ACCESS_TOKEN etc.). Record once and bail.
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolio.id,
      user_id: userId,
      broker: "saxo",
      env: portfolio.mode === "live_prod" ? "live" : "sim",
      method: "ROUTE_SKIPPED",
      path: "/route/adapter-unavailable",
      status: 503,
      request: asJson({ asOf, count: routable.length }),
      response: null,
      error: msg,
    });
    return routable.map((e) => ({
      symbol: e.symbol,
      side: e.side,
      quantity: e.quantity,
      status: "skipped",
      skipped: msg,
    }));
  }

  // Fetch broker account currency + available cash once per batch. We use
  // currency to record the FX rate the AI sized against, and cash to gate the
  // pre-placement reconciliation below. Non-blocking: on failure we fall
  // through with rate=1 stale and skip the affordability trim.
  let accountCurrency: string | null = null;
  let brokerCashAvailable: number | null = null;
  try {
    const bal = await adapter.getBalance();
    accountCurrency = bal.currency;
    const rawCash = Number(bal.cashAvailable ?? bal.cash);
    brokerCashAvailable = Number.isFinite(rawCash) ? rawCash : null;
  } catch {
    /* best-effort */
  }
  const pfRow = await supabaseAdmin
    .from("portfolios")
    .select("currency, fx_enabled, cash_by_ccy, fx_execution_mode")
    .eq("id", portfolio.id)
    .maybeSingle();
  const pfRowData = pfRow.data as
    | { currency?: string; fx_enabled?: boolean; cash_by_ccy?: Record<string, number> | null; fx_execution_mode?: string }
    | null;
  const portfolioCurrency = pfRowData?.currency?.toUpperCase() ?? "GBP";
  const fxEnabled = pfRowData?.fx_enabled === true;
  // Default to "spot" so every planned FX leg is placed at the broker
  // before the dependent buy is submitted. Only the explicit
  // fx_execution_mode='synthetic' opt-out keeps the wallet-only path.
  const fxExecutionMode: "synthetic" | "spot" =
    pfRowData?.fx_execution_mode === "synthetic" ? "synthetic" : "spot";



  let fxRate = 1;
  let fxStale = false;
  let fxSource = "identity";
  if (accountCurrency && accountCurrency.toUpperCase() !== portfolioCurrency) {
    const { getFxRate } = await import("@/lib/fx.server");
    const fx = await getFxRate(portfolioCurrency, accountCurrency);
    fxRate = fx.rate;
    fxStale = fx.stale;
    fxSource = fx.source;
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolio.id,
      user_id: userId,
      broker: "saxo",
      env: portfolio.mode === "live_prod" ? "live" : "sim",
      method: "FX_CAPTURE",
      path: `/fx/${portfolioCurrency}->${accountCurrency}`,
      status: fxStale ? 206 : 200,
      request: asJson({ asOf, decisionId, count: routable.length }),
      response: asJson({ rate: fxRate, source: fxSource, stale: fxStale }),
      error: fxStale ? "fx rate stale or fallback" : null,
    });
    // Fire an out-of-UI alert when the FX providers are actually down
    // (rate=1 identity fallback) so the operator hears about it even if
    // they don't have the portfolio page open.
    try {
      const { maybeNotifyFxUnhealthy } = await import("./fx-health-notify.server");
      maybeNotifyFxUnhealthy({
        portfolioId: portfolio.id,
        userId,
        pair: `${portfolioCurrency}->${accountCurrency}`,
        rate: fxRate,
        source: fxSource,
        stale: fxStale,
      });
    } catch {
      // never let a notifier crash the tick
    }

  }

  // ---------- Pre-placement cash reconciliation.
  // Refresh the local `current_cash` from the broker one more time immediately
  // before we start placing orders — top-of-tick sync ran minutes ago and
  // external deposits, withdrawals, or in-flight fills may have moved the
  // real number. Then trim any buys whose combined broker-currency notional
  // exceeds what the broker actually has available, so we never hand Saxo an
  // order that will come straight back as InsufficientCash.
  const preSkips = new Map<string, string>(); // clientOrderId key by symbol+side
  try {
    const { syncLiveCashFromBroker } = await import("./live-cash-sync.server");
    const { withOwnedClient } = await import("./_server/owned-client");
    const preSync = await syncLiveCashFromBroker(portfolio.id, withOwnedClient(userId));
    // If the drift-update ran, capture the fresh broker cash so the
    // affordability check below uses the same number the local DB just wrote.
    if (!preSync.skipped && Number.isFinite(preSync.brokerCash)) {
      brokerCashAvailable = Number(preSync.brokerCash);
    }
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolio.id,
      user_id: userId,
      broker: "saxo",
      env: portfolio.mode === "live_prod" ? "live" : "sim",
      method: "PRE_PLACE_RECONCILE",
      path: "/reconcile/pre-place",
      status: preSync.skipped ? 206 : 200,
      request: asJson({ asOf, decisionId, count: routable.length }),
      response: asJson(preSync),
      error: preSync.skipped ? preSync.reason : null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolio.id,
      user_id: userId,
      broker: "saxo",
      env: portfolio.mode === "live_prod" ? "live" : "sim",
      method: "PRE_PLACE_RECONCILE",
      path: "/reconcile/pre-place",
      status: 500,
      request: asJson({ asOf, decisionId, count: routable.length }),
      response: null,
      error: msg,
    });
  }

  // If broker and portfolio currencies differ but FX resolution collapsed to
  // the identity fallback (both live FX providers unreachable and no cached
  // rate available), the affordability trim would badly under-estimate the
  // broker-currency cost of every buy, causing InsufficientCash rejects at
  // the broker. Block cross-currency buys in that state rather than send
  // them to certain rejection. Sells are unaffected — they free cash.
  const fxIsBroken =
    accountCurrency != null &&
    accountCurrency.toUpperCase() !== portfolioCurrency &&
    fxStale &&
    fxRate === 1 &&
    fxSource.startsWith("fallback:");

  // Persistent circuit breaker: even if THIS tick's FX capture succeeded, a
  // recent identity-fallback in the log keeps the breaker OPEN until we see a
  // live provider capture strictly newer than the last fallback. This stops
  // cross-currency buys from resuming during a flaky recovery window.
  let fxCircuitOpen = false;
  let fxCircuitReason: string | null = null;
  if (
    accountCurrency != null &&
    accountCurrency.toUpperCase() !== portfolioCurrency
  ) {
    try {
      const { getFxCircuitState } = await import("./fx-circuit.server");
      const state = await getFxCircuitState(supabaseAdmin, portfolio.id, 24);
      fxCircuitOpen = state.open;
      fxCircuitReason = state.reason;
    } catch {
      /* fail-open on circuit lookup errors — the fxIsBroken check still guards */
    }
  }

  if (fxIsBroken || fxCircuitOpen) {
    const reason = fxIsBroken
      ? `fx ${portfolioCurrency}->${accountCurrency} unavailable; buy skipped to avoid InsufficientCash reject`
      : `fx circuit OPEN — pausing cross-currency buys until live FX provider recovers (${fxCircuitReason ?? "recent fallback"})`;
    for (const o of routable) {
      if (o.side === "buy") {
        preSkips.set(`${o.symbol}:${o.side}`, reason);
      }
    }
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolio.id,
      user_id: userId,
      broker: "saxo",
      env: portfolio.mode === "live_prod" ? "live" : "sim",
      method: fxIsBroken ? "PRE_PLACE_FX_BLOCK" : "PRE_PLACE_FX_CIRCUIT_OPEN",
      path: `/fx/${portfolioCurrency}->${accountCurrency}`,
      status: 424,
      request: asJson({ asOf, decisionId, count: routable.length }),
      response: asJson({ fxSource, fxStale, fxCircuitOpen, fxCircuitReason }),
      error: reason,
    });
  } else if (fxEnabled) {
    // ---------- Phase B: per-currency wallet routing.
    // Rather than measure every buy against a single broker-cash number, walk
    // the portfolio's per-currency wallet (`cash_by_ccy`) and pay each buy
    // from its instrument's own quote currency. When the target currency is
    // short, top it up from the base currency via a synthetic FX conversion
    // leg captured at the same rate the AI sized against.
    const buys = routable
      .filter((o) => o.side === "buy")
      .slice()
      .sort((a, b) => b.quantity * b.price - a.quantity * a.price);

    if (buys.length > 0) {
      // Resolve instrument currency per symbol. Prefer the value the caller
      // passed on the ExecutedOrder; fall back to saxo_instrument_cache; then
      // to the portfolio base currency so we never crash on an unknown row.
      const symbols = Array.from(new Set(buys.map((o) => o.symbol)));
      const symToCcy = new Map<string, string>();
      for (const o of buys) {
        if (o.instrument_ccy) symToCcy.set(o.symbol, o.instrument_ccy.toUpperCase());
      }
      const missing = symbols.filter((s) => !symToCcy.has(s));
      if (missing.length > 0) {
        const cache = await supabaseAdmin
          .from("saxo_instrument_cache")
          .select("symbol, currency")
          .in("symbol", missing);
        for (const row of cache.data ?? []) {
          if (row.currency) symToCcy.set(row.symbol, row.currency.toUpperCase());
        }
      }
      for (const s of symbols) if (!symToCcy.has(s)) symToCcy.set(s, portfolioCurrency);

      // Bulk FX matrix: base_ccy -> every instrument currency we'll spend in.
      const targetCcys = Array.from(new Set(symToCcy.values())).filter(
        (c) => c !== portfolioCurrency,
      );
      const { getFxMatrix, refreshFxMatrix } = await import("@/lib/fx.server");
      let matrix =
        targetCcys.length > 0
          ? await getFxMatrix(targetCcys.map((c) => ({ from: portfolioCurrency, to: c })))
          : new Map<string, { rate: number; stale: boolean; source: string }>();

      // Pre-trade FX matrix guard: block buys whose required base->ccy
      // conversion is missing, identity-fallback, or stale. The trimmer's
      // per-order lookup already skips buys with a null rate, but a stale
      // (non-null) rate would otherwise route with just a wider safety
      // buffer. When the operator's expectation is "no trades on bad FX",
      // this pre-empts that path deterministically and gives one audit row
      // per blocked pair.
      //
      // Refresh-and-retry: when the first pass blocks any pair, evict just
      // those pairs from the FX cache and re-query the live providers once.
      // Blocks that recover (e.g. a rate that was stale because the TTL
      // elapsed while providers were momentarily slow) then route normally
      // in this same tick instead of waiting for the next one. Pairs that
      // are still bad on the retry fall through to the original skip path
      // with a `retriedAt` marker so the audit row records both attempts.
      if (targetCcys.length > 0) {
        const { guardFxMatrix } = await import("./fx-matrix-guard");
        let guard = guardFxMatrix(portfolioCurrency, targetCcys, matrix);
        let retriedAt: string | null = null;
        if (guard.hasBlock) {
          const refreshPairs = guard.blocked.map((b) => ({ from: b.from, to: b.to }));
          const before = guard.blocked.map((b) => ({
            to: b.to,
            reason: b.reason,
            source: b.source ?? null,
          }));
          retriedAt = new Date().toISOString();
          try {
            const refreshed = await refreshFxMatrix(refreshPairs);
            for (const [k, v] of refreshed) matrix.set(k, v);
          } catch (err) {
            // Refresh itself failed (network); keep the original matrix and
            // let the guard block as before. Record why.
            await supabaseAdmin.from("live_broker_log").insert({
              portfolio_id: portfolio.id,
              user_id: userId,
              broker: "saxo",
              env: portfolio.mode === "live_prod" ? "live" : "sim",
              method: "PRE_PLACE_FX_MATRIX_REFRESH",
              path: `/fx/refresh`,
              status: 502,
              request: asJson({ asOf, decisionId, pairs: refreshPairs }),
              response: asJson({ before }),
              error: `fx refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          const guardAfter = guardFxMatrix(portfolioCurrency, targetCcys, matrix);
          const recovered = guard.blocked
            .filter((b) => !guardAfter.blockedCcys.has(b.to))
            .map((b) => b.to);
          await supabaseAdmin.from("live_broker_log").insert({
            portfolio_id: portfolio.id,
            user_id: userId,
            broker: "saxo",
            env: portfolio.mode === "live_prod" ? "live" : "sim",
            method: "PRE_PLACE_FX_MATRIX_REFRESH",
            path: `/fx/refresh`,
            status: recovered.length > 0 ? 200 : 424,
            request: asJson({ asOf, decisionId, pairs: refreshPairs }),
            response: asJson({
              before,
              after: guardAfter.blocked.map((b) => ({
                to: b.to,
                reason: b.reason,
                source: b.source ?? null,
              })),
              recovered,
            }),
            error:
              recovered.length > 0
                ? null
                : `fx refresh did not recover any of: ${refreshPairs
                    .map((p) => `${p.from}->${p.to}`)
                    .join(", ")}`,
          });
          guard = guardAfter;
        }
        if (guard.hasBlock) {
          for (const b of guard.blocked) {
            await supabaseAdmin.from("live_broker_log").insert({
              portfolio_id: portfolio.id,
              user_id: userId,
              broker: "saxo",
              env: portfolio.mode === "live_prod" ? "live" : "sim",
              method: "PRE_PLACE_FX_MATRIX_BLOCK",
              path: `/fx/${b.from}->${b.to}`,
              status: 424,
              request: asJson({ asOf, decisionId, reason: b.reason, retriedAt }),
              response: asJson({ source: b.source ?? null }),
              error: b.detail,
            });
          }
          // Skip every buy whose instrument currency is blocked. Sells are
          // unaffected — they free cash and don't need FX to route.
          for (const o of buys) {
            const ccy = (o.instrument_ccy ?? symToCcy.get(o.symbol) ?? portfolioCurrency).toUpperCase();
            if (guard.blockedCcys.has(ccy)) {
              const detail = guard.blocked.find((x) => x.to === ccy)?.detail ?? `fx ${portfolioCurrency}->${ccy} blocked`;
              preSkips.set(`${o.symbol}:${o.side}`, detail);
            }
          }
        }
      }



      const { readWallet, writeWalletFields } = await import("./portfolio-wallet");
      const { trimBuysToBudgetByCurrency } = await import("./pre-place-budget-multi-ccy");

      const wallet = readWallet({
        currency: portfolioCurrency,
        current_cash: brokerCashAvailable ?? undefined,
        cash_by_ccy: pfRowData?.cash_by_ccy ?? null,
      });

      const fxLookup = (from: string, to: string): number | null => {
        if (from === to) return 1;
        const hit = matrix.get(`${from}${to}`);
        if (!hit) return null;
        // A rate=1 identity fallback (both providers down) is unusable —
        // let the trimmer skip the buy instead of amplifying the reject.
        if (hit.source.startsWith("fallback:")) return null;
        return hit.rate;
      };
      const isStale = (from: string, to: string) => matrix.get(`${from}${to}`)?.stale === true;

      const anyStale = targetCcys.some((c) => matrix.get(`${portfolioCurrency}${c}`)?.stale);
      const safetyBufferPct = anyStale ? 0.05 : 0.01;

      const buyOrders = buys.map((o) => ({
        symbol: o.symbol,
        side: o.side,
        quantity: o.quantity,
        price: o.price,
        instrument_ccy: symToCcy.get(o.symbol) ?? portfolioCurrency,
      }));

      let trim = trimBuysToBudgetByCurrency(
        buyOrders,
        wallet,
        portfolioCurrency,
        fxLookup,
        { safetyBufferPct, allowFxConversion: true, isRateStale: isStale },
      );

      // Phase C: real spot FX. When fx_execution_mode='spot' and the adapter
      // implements placeFxSpot, submit each planned leg to the broker and
      // drop any buy whose leg failed. Then re-run the trimmer over the
      // survivors so wallet math reflects only successful legs.
      if (fxExecutionMode === "spot" && trim.fxLegs.length > 0 && typeof adapter.placeFxSpot !== "function") {
        // Spot FX is required to fund these buys, but the adapter can't
        // place FX. Drop every dependent buy and log one row per leg so
        // no order is submitted with an unfunded currency leg.
        for (const leg of trim.fxLegs) {
          await supabaseAdmin.from("live_broker_log").insert({
            portfolio_id: portfolio.id,
            user_id: userId,
            broker: "saxo",
            env: portfolio.mode === "live_prod" ? "live" : "sim",
            method: "FX_SPOT_UNSUPPORTED",
            path: `/fx-spot/${leg.fromCcy}->${leg.toCcy}`,
            status: 501,
            request: asJson({ asOf, decisionId, amountFrom: leg.amountFrom, plannedRate: leg.rate }),
            response: asJson({ reason: "adapter does not implement placeFxSpot" }),
            error: "adapter does not implement placeFxSpot",
          });
          preSkips.set(`${leg.triggeredBySymbol}:buy`, "fx spot unsupported by adapter");
        }
        trim = { ...trim, fxLegs: [], decisions: trim.decisions.filter((d) => {
          if (d.kind !== "allow") return true;
          return !trim.fxLegs.some((l) => l.triggeredBySymbol === d.order.symbol);
        }) };
      }
      if (fxExecutionMode === "spot" && trim.fxLegs.length > 0 && typeof adapter.placeFxSpot === "function") {

        const { survivingBuysAfterFxSpot } = await import("./fx-spot-plan");
        type SpotOutcome = import("./fx-spot-plan").FxSpotOutcome;
        const outcomes: SpotOutcome[] = [];
        for (const leg of trim.fxLegs) {
          const clientOrderId = `fx-${decisionId}-${leg.triggeredBySymbol}-${leg.fromCcy}${leg.toCcy}`;
          const spot = await adapter.placeFxSpot!({
            fromCcy: leg.fromCcy,
            toCcy: leg.toCcy,
            amountFrom: leg.amountFrom,
            clientOrderId,
          });
          const ok = spot.status === "submitted" || spot.status === "filled";
          await supabaseAdmin.from("live_broker_log").insert({
            portfolio_id: portfolio.id,
            user_id: userId,
            broker: "saxo",
            env: portfolio.mode === "live_prod" ? "live" : "sim",
            method: ok ? "FX_SPOT_PLACED" : "FX_SPOT_FAILED",
            path: `/fx-spot/${leg.fromCcy}->${leg.toCcy}`,
            status: ok ? 200 : 400,
            request: asJson({ asOf, decisionId, clientOrderId, amountFrom: leg.amountFrom, plannedRate: leg.rate }),
            response: asJson({
              brokerOrderId: spot.brokerOrderId,
              pairSymbol: spot.pairSymbol,
              fillRate: spot.fillRate,
              amountTo: spot.amountTo,
              status: spot.status,
              reason: spot.reason,
            }),
            error: ok ? null : (spot.reason ?? "fx spot failed"),
          });
          outcomes.push(
            ok
              ? { kind: "ok", triggerSymbol: leg.triggeredBySymbol, fillRate: spot.fillRate ?? leg.rate, amountTo: spot.amountTo ?? leg.amountTo }
              : { kind: "failed", triggerSymbol: leg.triggeredBySymbol, reason: spot.reason ?? "fx spot rejected" },
          );
          reconFxOutcomes.push(
            ok
              ? { triggerSymbol: leg.triggeredBySymbol, kind: "ok" }
              : { triggerSymbol: leg.triggeredBySymbol, kind: "failed", reason: spot.reason ?? "fx spot rejected" },
          );
        }
        const { survivors, droppedSymbols } = survivingBuysAfterFxSpot(buyOrders, trim, outcomes);
        if (droppedSymbols.size > 0) {
          // Re-plan against survivors so the persisted wallet & subsequent
          // per-symbol skip list reflect only successful legs.
          trim = trimBuysToBudgetByCurrency(
            survivors,
            wallet,
            portfolioCurrency,
            fxLookup,
            { safetyBufferPct, allowFxConversion: true, isRateStale: isStale },
          );
          for (const [sym, reason] of droppedSymbols) {
            preSkips.set(`${sym}:buy`, `fx spot failed: ${reason}`);
          }
        }
      }

      // Snapshot the final, actually-submitted FX legs for the post-broker
      // reconciler. This is the set the reconciler expects to see reflected
      // in successful outcomes, one entry per triggered symbol.
      for (const leg of trim.fxLegs) {
        reconPlannedLegs.push({
          triggeredBySymbol: leg.triggeredBySymbol,
          fromCcy: leg.fromCcy,
          toCcy: leg.toCcy,
          amountFrom: leg.amountFrom,
          amountTo: leg.amountTo,
          rate: leg.rate,
          stale: leg.stale,
        });
      }

      for (const d of trim.decisions) {
        if (d.kind === "skip") preSkips.set(`${d.order.symbol}:${d.order.side}`, d.reason);
      }


      // Persist wallet updates (FX conversion legs + buy debits are all
      // reflected in `finalWallet`). Sells will be credited by the fill
      // handler later; this write only reflects the pre-placement state.
      if (trim.fxLegs.length > 0) {
        const fields = writeWalletFields(trim.finalWallet, portfolioCurrency);
        await supabaseAdmin
          .from("portfolios")
          .update({ cash_by_ccy: asJson(fields.cash_by_ccy), current_cash: fields.current_cash })
          .eq("id", portfolio.id);

        for (const leg of trim.fxLegs) {
          await supabaseAdmin.from("live_broker_log").insert({
            portfolio_id: portfolio.id,
            user_id: userId,
            broker: "saxo",
            env: portfolio.mode === "live_prod" ? "live" : "sim",
            method: "FX_LEG",
            path: `/fx/${leg.fromCcy}->${leg.toCcy}`,
            status: leg.stale ? 206 : 200,
            request: asJson({ asOf, decisionId, triggeredBySymbol: leg.triggeredBySymbol }),
            response: asJson({
              fromCcy: leg.fromCcy,
              toCcy: leg.toCcy,
              amountFrom: leg.amountFrom,
              amountTo: leg.amountTo,
              rate: leg.rate,
              stale: leg.stale,
            }),
            error: leg.stale ? "fx leg used stale rate" : null,
          });
        }
      }

      if (trim.skippedCount > 0 || trim.fxLegs.length > 0) {
        await supabaseAdmin.from("live_broker_log").insert({
          portfolio_id: portfolio.id,
          user_id: userId,
          broker: "saxo",
          env: portfolio.mode === "live_prod" ? "live" : "sim",
          method: "PRE_PLACE_MULTI_CCY_TRIM",
          path: "/reconcile/pre-place/trim-multi-ccy",
          status: 200,
          request: asJson({
            asOf,
            decisionId,
            baseCcy: portfolioCurrency,
            wallet,
            safetyBufferPct,
            targetCcys,
            requestedByCcy: trim.totalRequestedByCcy,
            allowedByCcy: trim.totalAllowedByCcy,
          }),
          response: asJson({
            skippedCount: trim.skippedCount,
            fxLegs: trim.fxLegs,
            skipped: trim.decisions
              .filter((d) => d.kind === "skip")
              .map((d) => ({
                symbol: d.order.symbol,
                side: d.order.side,
                instrument_ccy: d.order.instrument_ccy,
                notionalNative: d.notionalNative,
                reason: d.reason,
              })),
            finalWallet: trim.finalWallet,
          }),
          error: null,
        });
      }
    }
  } else if (brokerCashAvailable != null) {
    const { trimBuysToBudget } = await import("./pre-place-budget");
    // Rank buys by broker-ccy notional so the biggest, most conviction-heavy
    // buys get the budget first. Sells are never gated on cash.
    const buys = routable
      .filter((o) => o.side === "buy")
      .slice()
      .sort((a, b) => b.quantity * b.price - a.quantity * a.price);
    if (buys.length > 0) {
      // When FX is stale (cached-stale) but non-identity, apply a wider
      // safety buffer to absorb intra-day drift. Fresh FX keeps the 1%
      // default; a stale non-identity rate widens to 5%.
      const safetyBufferPct = fxStale ? 0.05 : 0.01;
      const trim = trimBuysToBudget(buys, brokerCashAvailable, fxRate, { safetyBufferPct });
      for (const d of trim.decisions) {
        if (d.kind === "skip") {
          preSkips.set(`${d.order.symbol}:${d.order.side}`, d.reason);
        }
      }
      if (trim.skippedCount > 0) {
        await supabaseAdmin.from("live_broker_log").insert({
          portfolio_id: portfolio.id,
          user_id: userId,
          broker: "saxo",
          env: portfolio.mode === "live_prod" ? "live" : "sim",
          method: "PRE_PLACE_AFFORDABILITY",
          path: "/reconcile/pre-place/trim",
          status: 200,
          request: asJson({
            asOf,
            decisionId,
            brokerCashAvailable,
            fxRate,
            fxStale,
            safetyBufferPct,
            requested: trim.totalRequestedBrokerCcy,
            allowed: trim.totalAllowedBrokerCcy,
          }),
          response: asJson({
            skippedCount: trim.skippedCount,
            skipped: trim.decisions
              .filter((d) => d.kind === "skip")
              .map((d) => ({
                symbol: d.order.symbol,
                side: d.order.side,
                notionalBrokerCcy: d.notionalBrokerCcy,
                reason: d.reason,
              })),
          }),
          error: null,
        });
      }
    }
  }




  // ---------- Preflight: resolve every symbol to a Saxo instrument up front.
  // If any lookup fails, block the entire batch so we never place a partial
  // set of orders where some symbols would silently be dropped.
  const uniqueSymbols = Array.from(new Set(routable.map((o) => o.symbol)));
  const preflight: Array<{ symbol: string; ok: boolean; error?: string }> = [];
  for (const sym of uniqueSymbols) {
    try {
      await adapter.lookupUic(sym);
      preflight.push({ symbol: sym, ok: true });
    } catch (err) {
      preflight.push({
        symbol: sym,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const missing = preflight.filter((p) => !p.ok);
  if (missing.length > 0) {
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolio.id,
      user_id: userId,
      broker: "saxo",
      env: portfolio.mode === "live_prod" ? "live" : "sim",
      method: "PREFLIGHT_BLOCKED",
      path: "/route/preflight",
      status: 424,
      request: asJson({ asOf, decisionId, symbols: uniqueSymbols }),
      response: asJson({ preflight }),
      error: `Unresolved Saxo instrument(s): ${missing.map((m) => m.symbol).join(", ")}`,
    });
    const missingSet = new Set(missing.map((m) => m.symbol));
    return routable.map((e) => ({
      symbol: e.symbol,
      side: e.side,
      quantity: e.quantity,
      status: "skipped",
      skipped: missingSet.has(e.symbol)
        ? `preflight: ${missing.find((m) => m.symbol === e.symbol)?.error ?? "instrument not found"}`
        : "preflight blocked: another symbol in this batch failed instrument lookup",
    }));
  }

  // Broker-safe idempotency key. Scope it to the decision row when available so
  // a failed manual run can be retried in the same hour, while duplicate inserts
  // inside one decision still collapse on live_orders.client_order_id.
  const attemptSeed = decisionId ?? new Date().toISOString().slice(0, 16);


  // Saxo's /trade/v2/orders endpoint is rate-limited to roughly 1 request per
  // second per app. Space out submissions so a multi-order run doesn't get the
  // first order accepted and every follow-up rejected with HTTP 429.
  const ORDER_SPACING_MS = 1500;
  let firstOrder = true;

  for (const order of routable) {
    // Pre-placement affordability trim: buys that don't fit the freshly
    // reconciled broker cash are skipped before we ever call placeOrder.
    const skipReason = preSkips.get(`${order.symbol}:${order.side}`);
    if (skipReason) {
      results.push({
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        status: "skipped",
        skipped: skipReason,
      });
      continue;
    }
    if (!firstOrder) {
      await new Promise((resolve) => setTimeout(resolve, ORDER_SPACING_MS));
    }
    firstOrder = false;

    const clientOrderId = makeClientOrderId({
      portfolioId: portfolio.id,
      attemptSeed,
      symbol: order.symbol,
      side: order.side,
    });

    // Round quantity to a whole share (Saxo Stock/Etf orders reject fractional
    // Amount). Skip if this rounds to zero.
    const qty = Math.floor(order.quantity);
    if (qty <= 0) {
      results.push({
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        status: "skipped",
        skipped: "quantity < 1 whole share",
      });
      continue;
    }

    // Insert-first: DB unique index on client_order_id is the source of truth
    // for idempotency. On unique violation (23505) we look up the winner and
    // report it — no broker call is made for the duplicate.
    const inserted = await supabaseAdmin
      .from("live_orders")
      .insert({
        portfolio_id: portfolio.id,
        user_id: userId,
        decision_id: decisionId,
        broker: "saxo",
        client_order_id: clientOrderId,
        symbol: order.symbol,
        side: order.side,
        quantity: qty,
        order_type: "market",
        status: "pending",
        submitted_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (inserted.error || !inserted.data) {
      const isDuplicate = inserted.error?.code === "23505";
      if (isDuplicate) {
        const existing = await supabaseAdmin
          .from("live_orders")
          .select("id, status, broker_order_id")
          .eq("client_order_id", clientOrderId)
          .maybeSingle();
        results.push({
          symbol: order.symbol,
          side: order.side,
          quantity: qty,
          status: existing.data?.status ?? "duplicate",
          brokerOrderId: existing.data?.broker_order_id ?? undefined,
          skipped: "duplicate client_order_id (already routed this hour)",
        });
        continue;
      }
      results.push({
        symbol: order.symbol,
        side: order.side,
        quantity: qty,
        status: "error",
        reason: inserted.error?.message ?? "insert failed",
      });
      continue;
    }
    const liveOrderId = inserted.data.id as string;


    let brokerRes: BrokerOrderResult;
    try {
      brokerRes = await adapter.placeOrder({
        symbol: order.symbol,
        side: order.side,
        quantity: qty,
        orderType: "market",
        clientOrderId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabaseAdmin
        .from("live_orders")
        .update({ status: "error", reject_reason: msg.slice(0, 500) })
        .eq("id", liveOrderId);
      results.push({
        symbol: order.symbol,
        side: order.side,
        quantity: qty,
        status: "error",
        reason: msg,
      });
      continue;
    }

    await supabaseAdmin
      .from("live_orders")
      .update({
        status: brokerRes.status,
        broker_order_id: brokerRes.brokerOrderId || null,
        reject_reason: brokerRes.reason ?? null,
      })
      .eq("id", liveOrderId);

    if (brokerRes.status === "filled" && brokerRes.filledQuantity && brokerRes.avgFillPrice) {
      await supabaseAdmin.from("live_fills").insert({
        order_id: liveOrderId,
        portfolio_id: portfolio.id,
        user_id: userId,
        symbol: order.symbol,
        side: order.side,
        quantity: brokerRes.filledQuantity,
        fill_price: brokerRes.avgFillPrice,
        broker_fill_id: brokerRes.brokerOrderId || null,
      });
    }

    results.push({
      symbol: order.symbol,
      side: order.side,
      quantity: qty,
      status: brokerRes.status,
      brokerOrderId: brokerRes.brokerOrderId,
      reason: brokerRes.reason,
    });
  }

  // ---------- Post-broker reconciliation.
  // Verify every routed buy landed with the FX legs the trimmer planned.
  // Each entry is written as its own audit row so the FX health card + trade
  // error dashboard can render funded vs failed at a glance, and so a rerun
  // never silently overwrites a prior verdict for the same buy.
  if (results.some((r) => r.side === "buy")) {
    const { reconcileBuysWithFxLegs } = await import("./post-broker-reconciliation");
    const recon = reconcileBuysWithFxLegs(
      results.map((r) => ({
        symbol: r.symbol,
        side: r.side,
        status: r.status,
        reason: r.reason,
        skipped: r.skipped,
      })),
      reconPlannedLegs,
      reconFxOutcomes,
    );
    for (const entry of recon) {
      await supabaseAdmin.from("live_broker_log").insert({
        portfolio_id: portfolio.id,
        user_id: userId,
        broker: "saxo",
        env: portfolio.mode === "live_prod" ? "live" : "sim",
        method: "POST_BROKER_RECON",
        path: `/reconcile/post-broker/${entry.symbol}`,
        status: entry.status === "fully_funded" ? 200 : 424,
        request: asJson({
          asOf,
          decisionId,
          expectedFxLegs: entry.expectedFxLegs,
          orderStatus: entry.orderStatus,
        }),
        response: asJson({
          status: entry.status,
          fulfilledFxLegs: entry.fulfilledFxLegs,
          reason: entry.reason,
        }),
        error: entry.status === "failed" ? entry.reason : null,
      });
    }
  }

  return results;
}


function makeClientOrderId(args: {
  portfolioId: string;
  attemptSeed: string;
  symbol: string;
  side: "buy" | "sell";
}): string {
  const hash = createHash("sha256")
    .update(`${args.portfolioId}:${args.attemptSeed}:${args.symbol}:${args.side}`)
    .digest("hex")
    .slice(0, 24);
  return `aegis:${hash}`;
}
