// Orphaned pending-order sweeper. Server-only.
//
// Runs BEFORE new trades are considered (start of every live tick, plus a
// standalone cron) so a stuck order can never keep blocking its symbol:
//   1. Load every non-terminal `live_orders` row for the portfolio.
//   2. Ask the broker which orders are actually still working.
//   3. Classify (see orphan-order-sweep.ts) and act:
//        cancel_broker      -> DELETE at broker, mark cancelled locally
//        cancel_untracked   -> DELETE at broker (no local row to update)
//        reconcile          -> hand to the order reconciler for the true outcome
//        close_local        -> mark cancelled locally with an audit reason
// Every action writes an `order_reconcile_events` row, so "why did my sell
// disappear?" always has an answer.

import type { SaxoAdapter } from "./brokers/saxo.server";
import { logReconcileEvent } from "./reconcile-event-log.server";
import {
  classifyOrphanOrders,
  type BrokerWorkingOrder,
  type LocalOpenOrder,
  type OrphanFinding,
  type SweepThresholds,
} from "./orphan-order-sweep";

export interface OrphanSweepResult {
  scanned: number;
  cancelledAtBroker: number;
  cancelledUntracked: number;
  closedLocally: number;
  reconciled: number;
  failures: number;
  brokerListOk: boolean;
  findings: OrphanFinding[];
}

const OPEN_STATUSES = ["pending", "submitted", "working", "partial"];

export async function sweepOrphanOrdersForPortfolio(params: {
  portfolioId: string;
  userId: string;
  adapter: Pick<SaxoAdapter, "listWorkingOrders" | "cancelOrder">;
  env?: "sim" | "live";
  lookbackHours?: number;
  thresholds?: SweepThresholds;
  nowMs?: number;
  source?: string;
  /** Set false in tests / dry runs: classify and log, but don't mutate anything. */
  execute?: boolean;
}): Promise<OrphanSweepResult> {
  const { portfolioId, userId, adapter } = params;
  const env = params.env ?? "sim";
  const source = params.source ?? "orphan-sweep";
  const execute = params.execute !== false;
  const nowMs = params.nowMs ?? Date.now();
  const sinceIso = new Date(nowMs - (params.lookbackHours ?? 30 * 24) * 3600_000).toISOString();

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data, error } = await supabaseAdmin
    .from("live_orders")
    .select("id, symbol, side, status, quantity, broker_order_id, submitted_at, created_at")
    .eq("portfolio_id", portfolioId)
    .in("status", OPEN_STATUSES)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`load open live_orders failed: ${error.message}`);

  const local: LocalOpenOrder[] = (data ?? []).map((r) => ({
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    status: r.status,
    quantity: Number(r.quantity),
    brokerOrderId: r.broker_order_id ?? null,
    placedAt: r.submitted_at ?? r.created_at ?? null,
  }));

  let brokerWorking: BrokerWorkingOrder[] = [];
  let brokerListOk = true;
  try {
    brokerWorking = (await adapter.listWorkingOrders()) as BrokerWorkingOrder[];
  } catch {
    brokerListOk = false;
  }

  const findings = classifyOrphanOrders({
    local,
    brokerWorking,
    brokerListOk,
    nowMs,
    ...(params.thresholds ? { thresholds: params.thresholds } : {}),
  });

  const result: OrphanSweepResult = {
    scanned: local.length,
    cancelledAtBroker: 0,
    cancelledUntracked: 0,
    closedLocally: 0,
    reconciled: 0,
    failures: 0,
    brokerListOk,
    findings,
  };

  const localById = new Map(local.map((r) => [r.id, r]));
  const needsReconcile = findings.some((f) => f.action === "reconcile");

  for (const f of findings) {
    if (f.action === "none" || f.action === "reconcile") continue;
    if (!execute) continue;
    const row = f.orderId ? localById.get(f.orderId) : undefined;

    if (f.action === "cancel_broker" || f.action === "cancel_untracked") {
      const res = f.brokerOrderId
        ? await adapter.cancelOrder(f.brokerOrderId)
        : { ok: false, reason: "no broker order id" };
      if (!res.ok) {
        result.failures += 1;
        if (row) {
          await logReconcileEvent({
            orderId: row.id,
            portfolioId,
            userId,
            env,
            brokerOrderId: f.brokerOrderId,
            symbol: f.symbol,
            side: row.side,
            previousStatus: row.status,
            newStatus: row.status,
            outcome: "error",
            reasonCode: "orphan_cancel_failed",
            reason: `cancel rejected: ${res.reason ?? "unknown"}`,
            source,
            submittedAt: row.placedAt,
          });
        }
        continue;
      }

      if (f.action === "cancel_untracked") {
        result.cancelledUntracked += 1;
        continue;
      }

      result.cancelledAtBroker += 1;
      if (row) {
        await markCancelled(portfolioId, row, `orphan sweep: ${f.reason}`);
        await logReconcileEvent({
          orderId: row.id,
          portfolioId,
          userId,
          env,
          brokerOrderId: f.brokerOrderId,
          symbol: f.symbol,
          side: row.side,
          previousStatus: row.status,
          newStatus: "cancelled",
          outcome: "cancelled",
          reasonCode: "orphan_cancelled_stale_working",
          reason: f.reason,
          source,
          submittedAt: row.placedAt,
        });
      }
      continue;
    }

    if (f.action === "close_local" && row) {
      await markCancelled(portfolioId, row, `orphan sweep: ${f.reason}`);
      result.closedLocally += 1;
      await logReconcileEvent({
        orderId: row.id,
        portfolioId,
        userId,
        env,
        brokerOrderId: f.brokerOrderId,
        symbol: f.symbol,
        side: row.side,
        previousStatus: row.status,
        newStatus: "cancelled",
        outcome: "cancelled",
        reasonCode: row.brokerOrderId
          ? "orphan_closed_abandoned"
          : "orphan_closed_no_broker_id",
        reason: f.reason,
        source,
        submittedAt: row.placedAt,
      });
    }
  }

  // Orders the broker no longer lists may have filled — the reconciler is the
  // only thing that can book that fill, so run it before the tick trades.
  if (execute && needsReconcile) {
    try {
      const { reconcileOrderStatusesForPortfolio } = await import("./order-reconciliation.server");
      const summary = await reconcileOrderStatusesForPortfolio({
        portfolioId,
        userId,
        adapter: adapter as SaxoAdapter,
        lookbackHours: params.lookbackHours ?? 30 * 24,
        source,
      });
      result.reconciled = summary.scanned;
    } catch {
      result.failures += 1;
    }
  }

  return result;
}

async function markCancelled(
  portfolioId: string,
  row: LocalOpenOrder,
  reason: string,
): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin
    .from("live_orders")
    .update({ status: "cancelled", reject_reason: reason.slice(0, 500) })
    .eq("id", row.id)
    .eq("portfolio_id", portfolioId);
}
