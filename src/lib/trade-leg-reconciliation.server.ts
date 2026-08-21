// Automatic post-tick trade reconciliation.
//
// Runs fire-and-forget at the end of every live tick: takes the decision the
// engine just wrote, pairs each intended leg with the broker orders/fills that
// followed it, and raises a notification for every mismatch or dropped leg.
// Deduplicated per discrepancy key so a stuck order alerts once, not hourly.
//
// Never throws into the caller: a reconciliation failure must not break a tick.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  reconcileTradeLegs,
  type ExecutedOrder,
  type IntendedLeg,
  type LegDiscrepancy,
  type LegReconResult,
} from "./trade-leg-reconciliation";

/** How far back to look for the decision this tick produced. */
const DECISION_LOOKBACK_MIN = 90;
/** Orders are expected to land within this window after the decision. */
const ORDER_WINDOW_MIN = 45;
/** Don't repeat the same discrepancy key inside this window. */
const COOLDOWN_HOURS = 12;
const MAX_NOTIFICATIONS = 10;

type LooseOrder = {
  symbol?: unknown;
  side?: unknown;
  quantity?: unknown;
  price?: unknown;
  rejected?: unknown;
};

/** Extract the intended legs from a `decisions.raw` blob. */
export function intendedLegsFromRaw(decisionId: string, raw: unknown): IntendedLeg[] {
  const blob = (raw ?? {}) as { orders?: LooseOrder[]; executed?: LooseOrder[] };
  const attempts = blob.executed?.length ? blob.executed : (blob.orders ?? []);
  const out: IntendedLeg[] = [];
  for (const o of attempts) {
    const symbol = typeof o?.symbol === "string" ? o.symbol : "";
    const qty = Number(o?.quantity ?? 0);
    if (!symbol || !Number.isFinite(qty) || qty <= 0) continue;
    out.push({
      decisionId,
      symbol,
      side: String(o?.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy",
      quantity: qty,
      price: Number.isFinite(Number(o?.price)) && Number(o?.price) > 0 ? Number(o?.price) : null,
      engineRejection: typeof o?.rejected === "string" && o.rejected.trim() ? o.rejected : null,
    });
  }
  return out;
}

/** Load intent + execution for the latest decision and reconcile them. */
export async function reconcileLatestTick(params: {
  portfolioId: string;
  nowMs?: number;
}): Promise<
  (LegReconResult & { decisionId: string | null; decisionAt: string | null }) | null
> {
  const now = params.nowMs ?? Date.now();
  const since = new Date(now - DECISION_LOOKBACK_MIN * 60_000).toISOString();

  const { data: decisions, error: decErr } = await supabaseAdmin
    .from("decisions")
    .select("id, created_at, raw")
    .eq("portfolio_id", params.portfolioId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);
  if (decErr) throw decErr;
  const decision = decisions?.[0];
  if (!decision) return null;

  const intended = intendedLegsFromRaw(decision.id as string, decision.raw);

  const startMs = Date.parse(decision.created_at as string);
  const { data: orderRows, error: ordErr } = await supabaseAdmin
    .from("live_orders")
    .select(
      "id, decision_id, symbol, side, quantity, status, reject_reason, broker_order_id, created_at",
    )
    .eq("portfolio_id", params.portfolioId)
    .gte("created_at", new Date(startMs - 60_000).toISOString())
    .lte("created_at", new Date(startMs + ORDER_WINDOW_MIN * 60_000).toISOString())
    .limit(200);
  if (ordErr) throw ordErr;

  const ids = (orderRows ?? []).map((o) => o.id as string);
  const fillsByOrder = new Map<string, { qty: number; notional: number }>();
  if (ids.length > 0) {
    const { data: fills, error: fillErr } = await supabaseAdmin
      .from("live_fills")
      .select("order_id, quantity, fill_price")
      .in("order_id", ids);
    if (fillErr) throw fillErr;
    for (const f of fills ?? []) {
      const key = f.order_id as string;
      const agg = fillsByOrder.get(key) ?? { qty: 0, notional: 0 };
      agg.qty += Number(f.quantity ?? 0);
      agg.notional += Number(f.quantity ?? 0) * Number(f.fill_price ?? 0);
      fillsByOrder.set(key, agg);
    }
  }

  const orders: ExecutedOrder[] = (orderRows ?? []).map((o) => {
    const agg = fillsByOrder.get(o.id as string);
    return {
      id: o.id as string,
      decisionId: (o.decision_id as string | null) ?? null,
      symbol: o.symbol as string,
      side: o.side as string,
      quantity: Number(o.quantity ?? 0),
      status: o.status as string,
      rejectReason: (o.reject_reason as string | null) ?? null,
      brokerOrderId: (o.broker_order_id as string | null) ?? null,
      createdAt: o.created_at as string,
      filledQuantity: agg?.qty ?? 0,
      avgFillPrice: agg && agg.qty > 0 ? agg.notional / agg.qty : null,
    };
  });

  const result = reconcileTradeLegs({ intended, orders, nowMs: now });
  return {
    ...result,
    decisionId: decision.id as string,
    decisionAt: decision.created_at as string,
  };
}

function titleFor(d: LegDiscrepancy): string {
  switch (d.code) {
    case "dropped_leg":
      return `${d.symbol}: intended ${d.side} never executed`;
    case "side_mismatch":
      return `${d.symbol}: broker order is on the wrong side`;
    case "quantity_short":
      return `${d.symbol}: short fill vs intended quantity`;
    case "quantity_over":
      return `${d.symbol}: executed more than intended`;
    case "price_deviation":
      return `${d.symbol}: fill price far from intent`;
    case "stale_pending":
      return `${d.symbol}: order still unresolved`;
    case "phantom_leg":
      return `${d.symbol}: broker order with no matching intent`;
  }
}

/** Fire-and-forget entry point used by the hourly run after each live tick. */
export function maybeReconcileTradeLegs(params: {
  portfolioId: string;
  userId: string;
  portfolioName?: string | null;
  nowMs?: number;
}): void {
  const { portfolioId, userId } = params;
  if (!portfolioId || !userId) return;

  void (async () => {
    try {
      const result = await reconcileLatestTick({
        portfolioId,
        ...(params.nowMs != null ? { nowMs: params.nowMs } : {}),
      });
      if (!result || result.discrepancies.length === 0) return;

      const cooldownSince = new Date(
        (params.nowMs ?? Date.now()) - COOLDOWN_HOURS * 3600_000,
      ).toISOString();
      const { data: recent } = await supabaseAdmin
        .from("notifications")
        .select("details")
        .eq("user_id", userId)
        .eq("category", "trade_leg_recon")
        .eq("portfolio_id", portfolioId)
        .gte("created_at", cooldownSince)
        .limit(200);
      const seen = new Set<string>();
      for (const n of recent ?? []) {
        const k = (n.details as { key?: unknown } | null)?.key;
        if (typeof k === "string") seen.add(k);
      }

      const fresh = result.discrepancies
        .filter((d) => !seen.has(d.key))
        .slice(0, MAX_NOTIFICATIONS);
      if (fresh.length === 0) return;

      const inserts = fresh.map((d) => ({
        user_id: userId,
        category: "trade_leg_recon",
        severity: d.severity,
        title: titleFor(d),
        body: d.detail,
        portfolio_id: portfolioId,
        details: {
          key: d.key,
          code: d.code,
          symbol: d.symbol,
          side: d.side,
          decision_id: d.decisionId,
          order_id: d.orderId,
          broker_order_id: d.brokerOrderId,
          intended_quantity: d.intendedQuantity,
          executed_quantity: d.executedQuantity,
          intended_price: d.intendedPrice,
          avg_fill_price: d.avgFillPrice,
          price_deviation_bps: d.priceDeviationBps,
          broker_status: d.brokerStatus,
          summary: { ...result.summary },
          portfolio_name: params.portfolioName ?? null,
        } as unknown as Json,
      }));

      const { error } = await supabaseAdmin.from("notifications").insert(inserts);
      if (error) throw error;
    } catch (e) {
      console.warn(
        "trade-leg reconciliation failed",
        e instanceof Error ? e.message : String(e),
      );
    }
  })();
}
