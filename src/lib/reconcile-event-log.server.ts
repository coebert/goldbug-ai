// Structured reconciliation event logger.
//
// Every time the order reconciler decides *why* a live order should move
// (or stay) in a given status, it writes a row to `order_reconcile_events`.
// That table is the audit trail behind the "why is this order stuck?"
// question — it captures the previous status, new status, machine-readable
// reason code, human reason, the raw Saxo response fields we saw, and the
// age of the order at the time of the decision.
//
// Keep this module dependency-light: it's imported by the reconciler and by
// the presumed-fill path; both run inside server functions.

import { asJson } from "@/lib/_server/db-json";

export type ReconcileOutcome =
  | "filled"
  | "partial"
  | "rejected"
  | "cancelled"
  | "still_working"
  | "unknown"
  | "no_broker_id"
  | "error";

// Machine-readable reason codes. Add new codes here as new decision branches
// appear so downstream dashboards can filter without regex on `reason`.
export type ReconcileReasonCode =
  // Broker confirmed via history endpoint:
  | "broker_history_filled"
  | "broker_history_partial"
  | "broker_history_rejected"
  | "broker_history_cancelled"
  | "broker_history_unknown_status"
  // Still visible in the open-orders list:
  | "broker_open_working"
  | "broker_open_partial_progress"
  // SIM presumed-fill path (no /hist available):
  | "sim_presumed_filled_market"
  | "sim_presumed_filled_partial"
  | "sim_presumed_rejected_stale"
  | "sim_presumed_cancelled_limit_stale"
  | "sim_keep_awaiting_broker"
  // Market-hours awareness (venue was closed for the entire life of the order):
  | "sim_keep_market_closed"
  | "sim_defer_stale_market_closed"
  // Orphaned pending-order sweeper:
  | "orphan_cancelled_stale_working"
  | "orphan_closed_no_broker_id"
  | "orphan_closed_abandoned"
  | "orphan_cancel_failed"
  // Local-state guards:
  | "no_broker_id"
  | "invalid_timestamp"
  | "future_submitted_at"
  | "zero_quantity"
  // Reconciler infrastructure failures:
  | "working_list_fetch_failed"
  | "history_fetch_failed"
  | "fill_insert_failed"
  | "status_update_failed";

export interface ReconcileEventInput {
  orderId: string;
  portfolioId: string;
  userId: string;
  broker?: string;
  env?: string;
  brokerOrderId?: string | null;
  symbol: string;
  side?: string | null;
  orderType?: string | null;
  previousStatus: string;
  newStatus: string;
  outcome: ReconcileOutcome;
  reasonCode: ReconcileReasonCode;
  reason?: string | null;
  source?: string; // "reconciler" | "backfill" | "presumed_fill" | ...
  filledQuantity?: number;
  avgFillPrice?: number | null;
  saxoStatus?: string | null;
  saxoReason?: string | null;
  saxoFilledAt?: string | null;
  saxoResponse?: unknown;
  submittedAt?: string | null;
  occurredAt?: string;
}

/**
 * Persist a single reconciliation decision. Never throws — logging must not
 * break the reconciler.
 */
export async function logReconcileEvent(input: ReconcileEventInput): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const submittedMs = input.submittedAt ? new Date(input.submittedAt).getTime() : null;
    const occurredIso = input.occurredAt ?? new Date().toISOString();
    const ageMs =
      submittedMs != null && Number.isFinite(submittedMs)
        ? Math.max(0, new Date(occurredIso).getTime() - submittedMs)
        : null;

    const { error } = await supabaseAdmin.from("order_reconcile_events").insert({
      order_id: input.orderId,
      portfolio_id: input.portfolioId,
      user_id: input.userId,
      broker: input.broker ?? "saxo",
      env: input.env ?? "sim",
      broker_order_id: input.brokerOrderId ?? null,
      symbol: input.symbol,
      side: input.side ?? null,
      order_type: input.orderType ?? null,
      previous_status: input.previousStatus,
      new_status: input.newStatus,
      outcome: input.outcome,
      reason_code: input.reasonCode,
      reason: input.reason ?? null,
      source: input.source ?? "reconciler",
      filled_quantity: input.filledQuantity ?? 0,
      avg_fill_price: input.avgFillPrice ?? null,
      saxo_status: input.saxoStatus ?? null,
      saxo_reason: input.saxoReason ?? null,
      saxo_filled_at: input.saxoFilledAt ?? null,
      saxo_response: input.saxoResponse === undefined ? null : asJson(input.saxoResponse),
      submitted_at: input.submittedAt ?? null,
      age_ms: ageMs,
      occurred_at: occurredIso,
    });
    if (error) {
      // Non-fatal: dump to console so it still shows up in the run logs.
      // eslint-disable-next-line no-console
      console.warn("[reconcile-log] insert failed", error.message);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[reconcile-log] threw", e instanceof Error ? e.message : String(e));
  }
}
