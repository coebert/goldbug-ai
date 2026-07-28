// Post-tick reconciliation: compare each AI decision's intended orders
// against `live_orders` rows actually written to the broker path. If a
// live_prod portfolio has intended trades but no live_orders were created
// for two consecutive ticks, emit an in-app notification (deduplicated by
// cooldown) and optionally fire a webhook. Fire-and-forget: a failure here
// must never break the trading tick.
//
// Configuration (optional):
//   ORDERS_RECONCILE_WEBHOOK_URL    JSON POSTed on trip
//   ORDERS_RECONCILE_WEBHOOK_TOKEN  Authorization: Bearer <token>

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const COOLDOWN_HOURS = 3;
// Look at the last 2 decisions (most recent + previous). Two consecutive
// misses = the alert condition. Look up to 6h back so a portfolio that
// runs less frequently still counts the true prior cycle.
const LOOKBACK_HOURS = 6;
// live_orders should land within a couple of minutes of the decision row.
// Give it a generous 15-minute window to absorb Saxo latency / retries.
const MATCH_WINDOW_MIN = 15;

type IntendedOrder = { symbol?: unknown; side?: unknown; quantity?: unknown };

function countIntended(raw: unknown): number {
  const orders = (raw as { orders?: unknown })?.orders;
  if (!Array.isArray(orders)) return 0;
  let n = 0;
  for (const o of orders as IntendedOrder[]) {
    const side = typeof o?.side === "string" ? o.side.toLowerCase() : "";
    const qty = Number(o?.quantity ?? 0);
    if ((side === "buy" || side === "sell") && Number.isFinite(qty) && qty > 0) n += 1;
  }
  return n;
}

export function maybeAlertOrdersReconciliation(params: {
  portfolioId: string;
  userId: string;
  portfolioName?: string | null;
}) {
  const { portfolioId, userId } = params;
  if (!portfolioId || !userId) return;

  void (async () => {
    try {
      const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();

      const { data: decisions, error: dErr } = await supabaseAdmin
        .from("decisions")
        .select("id, created_at, raw")
        .eq("portfolio_id", portfolioId)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(2);
      if (dErr) throw dErr;
      if (!decisions || decisions.length < 2) return;

      // Both cycles must have wanted to trade; a routine "hold" tick is
      // not a reconciliation failure.
      const intendedCounts = decisions.map((d) => countIntended(d.raw));
      if (intendedCounts.some((n) => n === 0)) return;

      let bothEmpty = true;
      for (const d of decisions) {
        const start = new Date(d.created_at as string).getTime();
        const endIso = new Date(start + MATCH_WINDOW_MIN * 60_000).toISOString();
        const startIso = new Date(start).toISOString();
        const { count, error } = await supabaseAdmin
          .from("live_orders")
          .select("id", { head: true, count: "exact" })
          .eq("portfolio_id", portfolioId)
          .gte("created_at", startIso)
          .lte("created_at", endIso);
        if (error) throw error;
        if ((count ?? 0) > 0) {
          bothEmpty = false;
          break;
        }
      }
      if (!bothEmpty) return;

      // Cool-down: skip if we already alerted recently.
      const cooldownSince = new Date(
        Date.now() - COOLDOWN_HOURS * 3600_000,
      ).toISOString();
      const { data: recent } = await supabaseAdmin
        .from("notifications")
        .select("id")
        .eq("user_id", userId)
        .eq("category", "orders_reconcile")
        .eq("portfolio_id", portfolioId)
        .gte("created_at", cooldownSince)
        .limit(1);
      if (recent && recent.length > 0) return;

      const [latest, prior] = decisions;
      const title = "Broker orders missing for the last 2 cycles";
      const body =
        `The AI intended ${intendedCounts[0]} order(s) this cycle and ` +
        `${intendedCounts[1]} last cycle, but no live_orders rows were written for either. ` +
        `Check broker connectivity, precheck rejections, and the executor.`;

      await supabaseAdmin.from("notifications").insert({
        user_id: userId,
        category: "orders_reconcile",
        severity: "critical",
        title,
        body,
        portfolio_id: portfolioId,
        details: {
          latest_decision_id: latest.id,
          prior_decision_id: prior.id,
          intended_latest: intendedCounts[0],
          intended_prior: intendedCounts[1],
          match_window_minutes: MATCH_WINDOW_MIN,
          lookback_hours: LOOKBACK_HOURS,
        },
      });

      const url = process.env.ORDERS_RECONCILE_WEBHOOK_URL;
      if (url) {
        const token = process.env.ORDERS_RECONCILE_WEBHOOK_TOKEN;
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (token) headers.authorization = `Bearer ${token}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5_000);
        try {
          const res = await fetch(url, {
            method: "POST",
            headers,
            signal: ctrl.signal,
            body: JSON.stringify({
              event: "orders.reconcile_two_cycle_miss",
              portfolioId,
              userId,
              portfolioName: params.portfolioName ?? null,
              intendedLatest: intendedCounts[0],
              intendedPrior: intendedCounts[1],
              at: new Date().toISOString(),
            }),
          });
          if (!res.ok) console.warn("orders-reconcile webhook non-2xx", res.status);
          await res.body?.cancel().catch(() => undefined);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (e) {
      console.warn(
        "orders-reconcile alert failed",
        e instanceof Error ? e.message : String(e),
      );
    }
  })();
}
