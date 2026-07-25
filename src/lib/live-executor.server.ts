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
    .select("currency")
    .eq("id", portfolio.id)
    .maybeSingle();
  const portfolioCurrency =
    (pfRow.data as { currency?: string } | null)?.currency?.toUpperCase() ?? "GBP";

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

  if (brokerCashAvailable != null) {
    const { trimBuysToBudget } = await import("./pre-place-budget");
    // Rank buys by broker-ccy notional so the biggest, most conviction-heavy
    // buys get the budget first. Sells are never gated on cash.
    const buys = routable
      .filter((o) => o.side === "buy")
      .slice()
      .sort((a, b) => b.quantity * b.price - a.quantity * a.price);
    if (buys.length > 0) {
      const trim = trimBuysToBudget(buys, brokerCashAvailable, fxRate);
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
