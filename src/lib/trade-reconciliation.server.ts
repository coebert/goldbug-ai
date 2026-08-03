// Server-side data loader for the planned-vs-actual reconciliation report.
//
// Reads run under the caller's own Supabase client, so RLS enforces
// ownership of decisions / live_orders / live_fills — no service_role here.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  buildReconciliationReport,
  type BrokerOrderRow,
  type FillRow,
  type PlannedAttempt,
  type ReconReport,
} from "./trade-reconciliation";

type LooseOrder = {
  symbol?: string;
  side?: string;
  quantity?: number;
  price?: number;
  value?: number;
  reason?: string;
  rejected?: string;
};

function plannedFromDecisions(
  rows: Array<{ id: string; run_date: string; raw: unknown }>,
): PlannedAttempt[] {
  const out: PlannedAttempt[] = [];
  for (const d of rows) {
    const raw = (d.raw ?? {}) as { orders?: LooseOrder[]; executed?: LooseOrder[] };
    // `executed` holds the post-guardrail attempt list (with `rejected` set on
    // vetoed rows); fall back to `orders` for older runs that lack it.
    const attempts = raw.executed?.length ? raw.executed : (raw.orders ?? []);
    for (const o of attempts) {
      if (!o?.symbol) continue;
      out.push({
        decisionId: d.id,
        runDate: d.run_date,
        symbol: String(o.symbol),
        side: String(o.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy",
        quantity: Number(o.quantity ?? 0),
        price: o.price != null ? Number(o.price) : null,
        value: o.value != null ? Number(o.value) : null,
        reason: o.reason ? String(o.reason) : null,
        engineRejection: o.rejected ? String(o.rejected) : null,
      });
    }
  }
  return out;
}

export async function buildTradeReconciliationReport(params: {
  db: SupabaseClient<Database>;
  userId: string;
  portfolioId?: string;
  days: number;
}): Promise<ReconReport> {
  const { db, userId, portfolioId } = params;
  const sinceIso = new Date(Date.now() - params.days * 86_400_000).toISOString();
  const sinceDate = sinceIso.slice(0, 10);

  // Restrict to portfolios the caller owns (RLS already does, but scoping
  // keeps the decisions join explicit for a single-portfolio request).
  let pfQuery = db.from("portfolios").select("id").eq("user_id", userId);
  if (portfolioId) pfQuery = pfQuery.eq("id", portfolioId);
  const pf = await pfQuery;
  if (pf.error) throw new Error(pf.error.message);
  const portfolioIds = (pf.data ?? []).map((p) => p.id as string);
  if (portfolioIds.length === 0) {
    return { rows: [], summary: emptySummary(), suitability: [] };
  }

  const [decisions, orders, blocks] = await Promise.all([
    db
      .from("decisions")
      .select("id, run_date, raw")
      .in("portfolio_id", portfolioIds)
      .gte("run_date", sinceDate)
      .order("run_date", { ascending: false })
      .limit(200),
    db
      .from("live_orders")
      .select("id, decision_id, symbol, side, quantity, status, reject_reason, broker_order_id, created_at")
      .in("portfolio_id", portfolioIds)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(500),
    db
      .from("broker_instrument_blocks")
      .select("symbol_key, reason")
      .eq("user_id", userId)
      .is("cleared_at", null),
  ]);

  if (decisions.error) throw new Error(decisions.error.message);
  if (orders.error) throw new Error(orders.error.message);

  const orderRows: BrokerOrderRow[] = (orders.data ?? []).map((o) => ({
    id: o.id as string,
    decisionId: (o.decision_id as string | null) ?? null,
    symbol: o.symbol as string,
    side: o.side as string,
    quantity: Number(o.quantity ?? 0),
    status: o.status as string,
    rejectReason: (o.reject_reason as string | null) ?? null,
    brokerOrderId: (o.broker_order_id as string | null) ?? null,
    createdAt: o.created_at as string,
  }));

  let fills: FillRow[] = [];
  if (orderRows.length > 0) {
    const f = await db
      .from("live_fills")
      .select("order_id, quantity, fill_price")
      .in(
        "order_id",
        orderRows.map((o) => o.id),
      );
    if (f.error) throw new Error(f.error.message);
    fills = (f.data ?? []).map((r) => ({
      orderId: r.order_id as string,
      quantity: Number(r.quantity ?? 0),
      fillPrice: Number(r.fill_price ?? 0),
    }));
  }

  return buildReconciliationReport({
    planned: plannedFromDecisions(decisions.data ?? []),
    orders: orderRows,
    fills,
    activeBlocks: (blocks.data ?? []).map((b) => ({
      symbolKey: b.symbol_key as string,
      reason: b.reason as string,
    })),
  });
}

function emptySummary() {
  return {
    attempts: 0,
    filled: 0,
    partial: 0,
    suitabilityRejected: 0,
    otherBrokerRejected: 0,
    blockedPreTrade: 0,
    vetoedByEngine: 0,
    pending: 0,
    notRouted: 0,
    unexecutedValue: 0,
    suitabilityBlockedValue: 0,
  };
}
