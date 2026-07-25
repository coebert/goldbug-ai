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
import { logReconcileEvent, type ReconcileReasonCode } from "./reconcile-event-log.server";
import { decideSimFill } from "./sim-fill-rules";

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
  statuses?: string[];
  /** Tagged onto every emitted reconcile event so backfills are distinguishable from the hourly loop. */
  source?: string;
}): Promise<OrderReconcileSummary> {
  const { portfolioId, userId, adapter } = params;
  const lookbackHours = params.lookbackHours ?? 72;
  const statuses = params.statuses ?? ["pending", "submitted", "partial"];
  const source = params.source ?? "reconciler";
  const sinceIso = new Date(Date.now() - lookbackHours * 3600_000).toISOString();

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const openOrders = await supabaseAdmin
    .from("live_orders")
    .select("id, symbol, side, quantity, order_type, status, broker_order_id, submitted_at, created_at")
    .eq("portfolio_id", portfolioId)
    .in("status", statuses)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true });

  if (openOrders.error) throw new Error(`load live_orders failed: ${openOrders.error.message}`);
  const rows = openOrders.data ?? [];

  // Fetch the whole working-order list once — cheaper than one call per order.
  let working: Awaited<ReturnType<SaxoAdapter["listWorkingOrders"]>> = [];
  let workingListError: string | null = null;
  try {
    working = await adapter.listWorkingOrders();
  } catch (e) {
    workingListError = e instanceof Error ? e.message : String(e);
    // If we can't reach the endpoint, log once and treat everything as unknown
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolioId,
      user_id: userId,
      broker: "saxo",
      env: adapter.env,
      method: "ORDER_RECON_LIST_FAILED",
      path: "/port/v1/orders/me",
      status: null,
      error: workingListError,
    });
  }
  const workingById = new Map(working.map((w) => [w.brokerOrderId, w]));

  const summary: OrderReconcileSummary = {
    scanned: rows.length, filled: 0, partial: 0, rejected: 0, cancelled: 0,
    stillWorking: 0, unknown: 0, rows: [],
  };

  for (const row of rows) {
    const brokerOrderId = row.broker_order_id ? String(row.broker_order_id) : null;
    const submittedAtIso = (row.submitted_at as string | null) ?? (row.created_at as string | null);
    const commonEvent = {
      orderId: row.id as string,
      portfolioId,
      userId,
      env: adapter.env,
      brokerOrderId,
      symbol: row.symbol as string,
      side: (row.side as string | null) ?? null,
      orderType: (row.order_type as string | null) ?? null,
      previousStatus: row.status as string,
      submittedAt: submittedAtIso,
      source,
    } as const;

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
      await logReconcileEvent({
        ...commonEvent,
        newStatus: row.status as string,
        outcome: "no_broker_id",
        reasonCode: "no_broker_id",
        reason: "order has no broker_order_id — never routed to Saxo",
      });
      continue;
    }

    const w = workingById.get(brokerOrderId);
    if (w) {
      // Still open. Only patch if partial fill made progress.
      if (w.filledAmount > 0 && w.filledAmount < w.amount) {
        const upd = await supabaseAdmin
          .from("live_orders")
          .update({ status: "partial" })
          .eq("id", row.id as string);
        if (upd.error) {
          await logReconcileEvent({
            ...commonEvent,
            newStatus: row.status as string,
            outcome: "error",
            reasonCode: "status_update_failed",
            reason: `failed to mark partial: ${upd.error.message}`,
            filledQuantity: w.filledAmount,
            saxoResponse: w,
          });
        }
        summary.partial++;
        summary.rows.push({
          orderId: row.id as string, brokerOrderId, symbol: row.symbol as string,
          outcome: "partial", previousStatus: row.status as string, newStatus: "partial",
          filledQuantity: w.filledAmount, avgFillPrice: null,
        });
        await logReconcileEvent({
          ...commonEvent,
          newStatus: "partial",
          outcome: "partial",
          reasonCode: "broker_open_partial_progress",
          reason: `order still open on Saxo with ${w.filledAmount}/${w.amount} filled`,
          filledQuantity: w.filledAmount,
          saxoStatus: "working",
          saxoResponse: w,
        });
      } else {
        summary.stillWorking++;
        summary.rows.push({
          orderId: row.id as string, brokerOrderId, symbol: row.symbol as string,
          outcome: "still_working", previousStatus: row.status as string, newStatus: row.status as string,
          filledQuantity: w.filledAmount, avgFillPrice: null,
        });
        await logReconcileEvent({
          ...commonEvent,
          newStatus: row.status as string,
          outcome: "still_working",
          reasonCode: "broker_open_working",
          reason: "order is in Saxo's open-orders list; awaiting fill",
          filledQuantity: w.filledAmount,
          saxoStatus: "working",
          saxoResponse: w,
        });
      }
      continue;
    }

    // Not in working list → ask history what happened.
    let hist: Awaited<ReturnType<SaxoAdapter["getHistoricalOrder"]>> = null;
    let histError: string | null = null;
    try {
      hist = await adapter.getHistoricalOrder(brokerOrderId, sinceIso);
    } catch (e) {
      histError = e instanceof Error ? e.message : String(e);
    }

    if (histError) {
      await logReconcileEvent({
        ...commonEvent,
        newStatus: row.status as string,
        outcome: "error",
        reasonCode: "history_fetch_failed",
        reason: `Saxo /hist call threw: ${histError}`,
      });
    }

    if (!hist) {
      // Saxo `/hist/v3/orders` is unavailable (SIM tenants + some LIVE
      // configurations). Delegate to the shared, unit-tested `decideSimFill`
      // rule so the reconciler and the manual backfill agree on when a
      // silent order can be presumed filled, presumed rejected, or must be
      // left alone. This is the SINGLE place presumption logic lives — do
      // not reintroduce inline age/type checks here.
      const orderType = String(row.order_type ?? "market").toLowerCase();
      const qty = Number(row.quantity ?? 0);
      const decision = decideSimFill({
        orderType,
        status: row.status as string,
        submittedAt: (row.submitted_at as string | null) ?? null,
        createdAt: (row.created_at as string | null) ?? null,
        quantity: qty,
        hasBrokerOrderId: true,
      });

      if (decision.kind === "presumed_filled") {
        // Best-effort fill price for display only. Broker-side cash truth
        // still comes from the /port/v1/positions reconcile.
        const priceRow = await supabaseAdmin
          .from("price_cache")
          .select("close")
          .eq("symbol", row.symbol as string)
          .order("as_of", { ascending: false })
          .limit(1)
          .maybeSingle();
        const fillPrice = Number(priceRow.data?.close ?? 0) || 0;

        const upd = await supabaseAdmin
          .from("live_orders")
          .update({ status: "filled" })
          .eq("id", row.id as string);

        let fillInsertError: string | null = null;
        if (qty > 0) {
          const ins = await supabaseAdmin.from("live_fills").insert({
            order_id: row.id as string,
            portfolio_id: portfolioId,
            user_id: userId,
            symbol: row.symbol as string,
            side: row.side as string,
            quantity: qty,
            fill_price: fillPrice,
            fee: 0,
            currency: "GBP",
            broker_fill_id: brokerOrderId,
            filled_at: new Date().toISOString(),
          });
          if (ins.error && ins.error.code !== "23505") {
            fillInsertError = ins.error.message;
            await supabaseAdmin.from("live_broker_log").insert({
              portfolio_id: portfolioId, user_id: userId, broker: "saxo",
              env: adapter.env, method: "ORDER_RECON_PRESUMED_FILL_INSERT_FAILED",
              path: "live_fills", status: null,
              request: asJson({ orderId: row.id, brokerOrderId }),
              error: ins.error.message,
            });
          }
        }

        summary.filled++;
        summary.rows.push({
          orderId: row.id as string, brokerOrderId, symbol: row.symbol as string,
          outcome: "filled", previousStatus: row.status as string, newStatus: "filled",
          filledQuantity: qty, avgFillPrice: fillPrice || null,
          reason: `presumed filled — ${decision.reason}`,
        });
        await logReconcileEvent({
          ...commonEvent,
          source: `${source}:presumed_fill`,
          newStatus: "filled",
          outcome: "filled",
          reasonCode:
            (row.status as string).toLowerCase() === "partial"
              ? "sim_presumed_filled_partial"
              : "sim_presumed_filled_market",
          reason: `${decision.reason} (age ${Math.round(decision.ageMs / 1000)}s)`,
          filledQuantity: qty,
          avgFillPrice: fillPrice || null,
          saxoStatus: workingListError ? "open_list_unavailable" : "absent_from_open_list",
          saxoReason:
            (upd.error ? `status update failed: ${upd.error.message}` : null) ??
            (fillInsertError ? `live_fills insert failed: ${fillInsertError}` : null),
          saxoResponse: { workingListError, histError, priceUsed: fillPrice, decision },
        });
        continue;
      }

      if (decision.kind === "presumed_rejected") {
        await supabaseAdmin
          .from("live_orders")
          .update({ status: "rejected", reject_reason: decision.reason })
          .eq("id", row.id as string);

        summary.rejected++;
        summary.rows.push({
          orderId: row.id as string, brokerOrderId, symbol: row.symbol as string,
          outcome: "rejected", previousStatus: row.status as string, newStatus: "rejected",
          filledQuantity: 0, avgFillPrice: null,
          reason: `presumed rejected — ${decision.reason}`,
        });
        await logReconcileEvent({
          ...commonEvent,
          source: `${source}:presumed_reject`,
          newStatus: "rejected",
          outcome: "rejected",
          reasonCode:
            orderType === "market"
              ? "sim_presumed_rejected_stale"
              : "sim_presumed_cancelled_limit_stale",
          reason: `${decision.reason} (age ${Math.round(decision.ageMs / 1000)}s)`,
          saxoStatus: workingListError ? "open_list_unavailable" : "absent_from_open_list",
          saxoResponse: { workingListError, histError, decision },
        });
        continue;
      }

      // decision.kind === "keep"
      summary.unknown++;
      summary.rows.push({
        orderId: row.id as string, brokerOrderId, symbol: row.symbol as string,
        outcome: "unknown", previousStatus: row.status as string, newStatus: row.status as string,
        filledQuantity: 0, avgFillPrice: null,
        reason: decision.reason,
      });
      await logReconcileEvent({
        ...commonEvent,
        source,
        newStatus: row.status as string,
        outcome: "unknown",
        reasonCode: "sim_keep_awaiting_broker",
        reason: decision.reason,
        saxoStatus: "absent_from_open_list",
        saxoResponse: { workingListError, histError, decision },
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
      await logReconcileEvent({
        ...commonEvent,
        newStatus: row.status as string,
        outcome: "unknown",
        reasonCode: "broker_history_unknown_status",
        reason: `Saxo returned unrecognised status "${hist.status}"`,
        filledQuantity: hist.filledAmount,
        avgFillPrice: hist.avgPrice,
        saxoStatus: hist.status,
        saxoReason: hist.reason ?? null,
        saxoFilledAt: hist.filledAt ?? null,
        saxoResponse: hist,
      });
      continue;
    }

    const upd = await supabaseAdmin
      .from("live_orders")
      .update({
        status: mapped,
        reject_reason: mapped === "rejected" ? (hist.reason ?? "rejected by broker") : null,
      })
      .eq("id", row.id as string);
    if (upd.error) {
      await logReconcileEvent({
        ...commonEvent,
        newStatus: row.status as string,
        outcome: "error",
        reasonCode: "status_update_failed",
        reason: `failed to update live_orders.status to ${mapped}: ${upd.error.message}`,
        saxoStatus: hist.status,
        saxoResponse: hist,
      });
    }

    let fillInsertError: string | null = null;
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
        fillInsertError = ins.error.message;
        // Non-duplicate insert failures should surface in the log but not fail
        // the whole reconcile pass.
        await supabaseAdmin.from("live_broker_log").insert({
          portfolio_id: portfolioId, user_id: userId, broker: "saxo",
          env: adapter.env, method: "ORDER_RECON_FILL_INSERT_FAILED",
          path: "live_fills", status: null,
          request: asJson({ orderId: row.id, brokerOrderId }),
          error: ins.error.message,
        });
        await logReconcileEvent({
          ...commonEvent,
          newStatus: mapped,
          outcome: "error",
          reasonCode: "fill_insert_failed",
          reason: `live_fills insert failed: ${ins.error.message}`,
          filledQuantity: hist.filledAmount,
          avgFillPrice: hist.avgPrice,
          saxoStatus: hist.status,
          saxoResponse: hist,
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

    const reasonCode: ReconcileReasonCode =
      mapped === "filled" ? "broker_history_filled"
      : mapped === "partial" ? "broker_history_partial"
      : mapped === "rejected" ? "broker_history_rejected"
      : mapped === "cancelled" ? "broker_history_cancelled"
      : "broker_open_working";
    await logReconcileEvent({
      ...commonEvent,
      newStatus: mapped,
      outcome: mapped === "submitted" ? "still_working" : mapped,
      reasonCode,
      reason:
        mapped === "rejected"
          ? `broker rejected order: ${hist.reason ?? "no reason provided"}`
          : mapped === "cancelled"
            ? `broker cancelled order${hist.reason ? `: ${hist.reason}` : ""}`
            : mapped === "filled"
              ? `broker confirmed full fill of ${hist.filledAmount} @ ${hist.avgPrice ?? "n/a"}`
              : mapped === "partial"
                ? `broker confirmed partial fill of ${hist.filledAmount}/${hist.amount} @ ${hist.avgPrice ?? "n/a"}`
                : `broker still working ${hist.filledAmount}/${hist.amount}`,
      filledQuantity: hist.filledAmount,
      avgFillPrice: hist.avgPrice,
      saxoStatus: hist.status,
      saxoReason: hist.reason ?? null,
      saxoFilledAt: hist.filledAt ?? null,
      saxoResponse: fillInsertError ? { ...hist, fillInsertError } : hist,
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
