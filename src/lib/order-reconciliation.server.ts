// Broker-order reconciliation. Server-only.
//
// For every live order that hasn't reached a terminal state locally, ask
// Saxo what actually happened: is it still working, was it filled, was it
// rejected? Then update `live_orders.status` and insert into `live_fills`
// so the dashboard reflects the true broker-side outcome.
//
// The routing loop in `live-executor.server.ts` marks orders as
// `submitted` (or `pending` on retry) but never learns about later state
// transitions (working → filled/rejected/cancelled). This reconciler is
// the missing loop.

import type { SaxoAdapter } from "./brokers/saxo.server";
import { asJson } from "@/lib/_server/db-json";

export type OrderReconcileOutcome =
  | "filled"
  | "partial"
  | "rejected"
  | "cancelled"
  | "still_working"
  | "unknown"
  | "no_broker_id";

export interface OrderReconcileRow {
  orderId: string;
  brokerOrderId: string | null;
  symbol: string;
  outcome: OrderReconcileOutcome;
  previousStatus: string;
  newStatus: string;
  filledQuantity: number;
  avgFillPrice: number | null;
  reason?: string;
}

export interface OrderReconcileSummary {
  scanned: number;
  filled: number;
  partial: number;
  rejected: number;
  cancelled: number;
  stillWorking: number;
  unknown: number;
  rows: OrderReconcileRow[];
}

// Saxo may return status strings in a variety of casings across historical
// vs open endpoints. Normalise to our internal `live_orders.status` enum.
function mapSaxoStatus(status: string, filledQty: number, amount: number):
  | "filled"
  | "partial"
  | "rejected"
  | "cancelled"
  | "submitted"
  | "unknown"
{
  const s = status.toLowerCase();
  if (s.includes("fill")) {
    if (filledQty > 0 && amount > 0 && filledQty < amount) return "partial";
    return "filled";
  }
  if (s.includes("reject") || s.includes("error") || s.includes("expired") || s.includes("declin")) {
    return "rejected";
  }
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("work") || s.includes("place") || s.includes("open")) return "submitted";
  return "unknown";
}

export async function reconcileOrderStatusesForPortfolio(params: {
  portfolioId: string;
  userId: string;
  adapter: SaxoAdapter;
  lookbackHours?: number;
}): Promise<OrderReconcileSummary> {
  const { portfolioId, userId, adapter } = params;
  const lookbackHours = params.lookbackHours ?? 72;
  const sinceIso = new Date(Date.now() - lookbackHours * 3600_000).toISOString();

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const openOrders = await supabaseAdmin
    .from("live_orders")
    .select("id, symbol, side, quantity, status, broker_order_id, submitted_at, created_at")
    .eq("portfolio_id", portfolioId)
    .in("status", ["pending", "submitted", "partial"])
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true });

  if (openOrders.error) throw new Error(`load live_orders failed: ${openOrders.error.message}`);
  const rows = openOrders.data ?? [];

  // Fetch the whole working-order list once — cheaper than one call per order.
  let working: Awaited<ReturnType<SaxoAdapter["listWorkingOrders"]>> = [];
  try {
    working = await adapter.listWorkingOrders();
  } catch (e) {
    // If we can't reach the endpoint, log once and treat everything as unknown
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolioId,
      user_id: userId,
      broker: "saxo",
      env: adapter.env,
      method: "ORDER_RECON_LIST_FAILED",
      path: "/port/v1/orders/me",
      status: null,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  const workingById = new Map(working.map((w) => [w.brokerOrderId, w]));

  const summary: OrderReconcileSummary = {
    scanned: rows.length, filled: 0, partial: 0, rejected: 0, cancelled: 0,
    stillWorking: 0, unknown: 0, rows: [],
  };

  for (const row of rows) {
    const brokerOrderId = row.broker_order_id ? String(row.broker_order_id) : null;
    if (!brokerOrderId) {
      summary.rows.push({
        orderId: row.id as string,
        brokerOrderId: null,
        symbol: row.symbol as string,
        outcome: "no_broker_id",
        previousStatus: row.status as string,
        newStatus: row.status as string,
        filledQuantity: 0,
        avgFillPrice: null,
        reason: "order never received a broker id",
      });
      continue;
    }

    const w = workingById.get(brokerOrderId);
    if (w) {
      // Still open. Only patch if partial fill made progress.
      if (w.filledAmount > 0 && w.filledAmount < w.amount) {
        await supabaseAdmin
          .from("live_orders")
          .update({ status: "partial" })
          .eq("id", row.id as string);
        summary.partial++;
        summary.rows.push({
          orderId: row.id as string, brokerOrderId, symbol: row.symbol as string,
          outcome: "partial", previousStatus: row.status as string, newStatus: "partial",
          filledQuantity: w.filledAmount, avgFillPrice: null,
        });
      } else {
        summary.stillWorking++;
        summary.rows.push({
          orderId: row.id as string, brokerOrderId, symbol: row.symbol as string,
          outcome: "still_working", previousStatus: row.status as string, newStatus: row.status as string,
          filledQuantity: w.filledAmount, avgFillPrice: null,
        });
      }
      continue;
    }

    // Not in working list → ask history what happened.
    const hist = await adapter.getHistoricalOrder(brokerOrderId, sinceIso);
    if (!hist) {
      summary.unknown++;
      summary.rows.push({
        orderId: row.id as string, brokerOrderId, symbol: row.symbol as string,
        outcome: "unknown", previousStatus: row.status as string, newStatus: row.status as string,
        filledQuantity: 0, avgFillPrice: null,
        reason: "not in open orders and history endpoint returned nothing",
      });
      continue;
    }

    const mapped = mapSaxoStatus(hist.status, hist.filledAmount, hist.amount);
    if (mapped === "unknown") {
      summary.unknown++;
      summary.rows.push({
        orderId: row.id as string, brokerOrderId, symbol: row.symbol as string,
        outcome: "unknown", previousStatus: row.status as string, newStatus: row.status as string,
        filledQuantity: hist.filledAmount, avgFillPrice: hist.avgPrice,
        reason: `unrecognised Saxo status "${hist.status}"`,
      });
      continue;
    }

    await supabaseAdmin
      .from("live_orders")
      .update({
        status: mapped,
        reject_reason: mapped === "rejected" ? (hist.reason ?? "rejected by broker") : null,
      })
      .eq("id", row.id as string);

    if ((mapped === "filled" || mapped === "partial") && hist.filledAmount > 0) {
      // Insert (idempotent-ish): broker_fill_id = brokerOrderId means one row
      // per broker order. If the row already exists we skip on unique-violation.
      const fillPrice = hist.avgPrice ?? 0;
      const ins = await supabaseAdmin.from("live_fills").insert({
        order_id: row.id as string,
        portfolio_id: portfolioId,
        user_id: userId,
        symbol: row.symbol as string,
        side: row.side as string,
        quantity: hist.filledAmount,
        fill_price: fillPrice,
        fee: 0,
        currency: "GBP",
        broker_fill_id: brokerOrderId,
        filled_at: hist.filledAt ?? new Date().toISOString(),
      });
      if (ins.error && ins.error.code !== "23505") {
        // Non-duplicate insert failures should surface in the log but not fail
        // the whole reconcile pass.
        await supabaseAdmin.from("live_broker_log").insert({
          portfolio_id: portfolioId, user_id: userId, broker: "saxo",
          env: adapter.env, method: "ORDER_RECON_FILL_INSERT_FAILED",
          path: "live_fills", status: null,
          request: asJson({ orderId: row.id, brokerOrderId }),
          error: ins.error.message,
        });
      }
    }

    if (mapped === "filled") summary.filled++;
    else if (mapped === "partial") summary.partial++;
    else if (mapped === "rejected") summary.rejected++;
    else if (mapped === "cancelled") summary.cancelled++;

    summary.rows.push({
      orderId: row.id as string,
      brokerOrderId,
      symbol: row.symbol as string,
      outcome: mapped === "submitted" ? "still_working" : mapped,
      previousStatus: row.status as string,
      newStatus: mapped,
      filledQuantity: hist.filledAmount,
      avgFillPrice: hist.avgPrice,
      reason: mapped === "rejected" ? hist.reason : undefined,
    });
  }

  await supabaseAdmin.from("live_broker_log").insert({
    portfolio_id: portfolioId, user_id: userId, broker: "saxo",
    env: adapter.env, method: "ORDER_RECON",
    path: "/reconcile/orders", status: 200,
    request: asJson({ lookbackHours, scanned: summary.scanned }),
    response: asJson({
      filled: summary.filled, partial: summary.partial, rejected: summary.rejected,
      cancelled: summary.cancelled, stillWorking: summary.stillWorking, unknown: summary.unknown,
    }),
  });

  return summary;
}
