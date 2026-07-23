// Routes AI-executed orders to the Saxo broker adapter for live_sim / live_prod
// portfolios. Idempotent via a deterministic client_order_id keyed on
// (portfolio_id, trade_date, symbol, side). Never called for paper mode.
//
// This runs AFTER the simulator has already updated local holdings/cash, so
// the local state is a best-effort mirror and the nightly reconciliation cron
// squares it against actual broker positions.

import type { BrokerOrderResult } from "@/lib/brokers/adapter";

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
        request: { asOf, decisionId, count: executed.length } as never,
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
      request: { asOf, count: routable.length } as never,
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

  // Fetch broker account currency once per batch so we can record the FX rate
  // used to translate the portfolio-currency notional into the currency Saxo
  // will actually clear against. Non-blocking: fallback records rate=1 stale.
  let accountCurrency: string | null = null;
  try {
    const bal = await adapter.getBalance();
    accountCurrency = bal.currency;
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
      request: { asOf, decisionId, count: routable.length } as never,
      response: { rate: fxRate, source: fxSource, stale: fxStale } as never,
      error: fxStale ? "fx rate stale or fallback" : null,
    });
  }

  // Hour-bucketed idempotency key. Repeated CRON firings within the same UTC
  // hour collapse to the same key per (portfolio, symbol, side), and the
  // UNIQUE index on live_orders.client_order_id prevents duplicate rows even
  // under concurrent invocation.
  const hourBucket = new Date().toISOString().slice(0, 13); // e.g. "2026-07-23T14"


  for (const order of routable) {
    const clientOrderId = `aegis:${portfolio.id}:${hourBucket}:${order.symbol}:${order.side}`;

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
      } as never)
      .select("id")
      .single();

    if (inserted.error || !inserted.data) {
      const isDuplicate = inserted.error?.code === "23505";
      if (isDuplicate) {
        const existing = await supabaseAdmin
          .from("live_orders")
          .select("id, status, broker_order_id")
          .eq("client_order_id" as never, clientOrderId as never)
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
      } as never);
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
