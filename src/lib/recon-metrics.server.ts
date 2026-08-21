// Server side of reconciliation outcome metrics: read the raised discrepancies
// back out of `notifications`, aggregate them over time, and raise a metric
// alert when dropped legs spike, inventory nearly strands, or adverse prints
// start costing real money.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  computeReconMetrics,
  type ReconMetricsSummary,
  type ReconObservation,
} from "./recon-metrics";
import type { LegDiscrepancyCode, LegSeverity } from "./trade-leg-reconciliation";

const VALID_CODES = new Set<LegDiscrepancyCode>([
  "dropped_leg",
  "side_mismatch",
  "quantity_short",
  "quantity_over",
  "price_deviation",
  "stale_pending",
  "phantom_leg",
]);

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Map a `trade_leg_recon` notification row into a metric observation. */
export function observationFromNotification(row: {
  created_at: string;
  severity?: unknown;
  details: unknown;
}): ReconObservation | null {
  const det = (row.details ?? {}) as Record<string, unknown>;
  const code = det["code"];
  if (typeof code !== "string" || !VALID_CODES.has(code as LegDiscrepancyCode)) return null;
  const occurrences = Number(det["occurrences"] ?? 1);
  return {
    at: row.created_at,
    code: code as LegDiscrepancyCode,
    severity: (row.severity === "critical" ? "critical" : "warning") as LegSeverity,
    symbol: typeof det["symbol"] === "string" ? det["symbol"] : "",
    side: det["side"] === "sell" ? "sell" : "buy",
    intendedQuantity: numOrNull(det["intended_quantity"]),
    executedQuantity: numOrNull(det["executed_quantity"]),
    priceDeviationBps: numOrNull(det["price_deviation_bps"]),
    occurrences: Number.isFinite(occurrences) && occurrences > 0 ? occurrences : 1,
  };
}

/** Aggregate reconciliation outcomes for a user (optionally one portfolio). */
export async function buildReconMetrics(params: {
  db?: SupabaseClient<never>;
  userId: string;
  portfolioId?: string | undefined;
  windowDays?: number;
  bucketHours?: number;
  nowMs?: number;
}): Promise<ReconMetricsSummary> {
  const db = (params.db ?? supabaseAdmin) as unknown as typeof supabaseAdmin;
  const windowDays = Math.min(90, Math.max(1, params.windowDays ?? 14));
  const now = params.nowMs ?? Date.now();
  const since = new Date(now - windowDays * 86400_000).toISOString();

  let q = db
    .from("notifications")
    .select("created_at, severity, details")
    .eq("user_id", params.userId)
    .eq("category", "trade_leg_recon")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (params.portfolioId) q = q.eq("portfolio_id", params.portfolioId);

  const { data, error } = await q;
  if (error) throw error;

  const observations: ReconObservation[] = [];
  for (const row of data ?? []) {
    const obs = observationFromNotification(
      row as { created_at: string; severity?: unknown; details: unknown },
    );
    if (obs) observations.push(obs);
  }

  return computeReconMetrics({
    observations,
    nowMs: now,
    windowDays,
    ...(params.bucketHours != null ? { bucketHours: params.bucketHours } : {}),
  });
}

/** Cooldown for a repeated metric alert. */
const ALERT_COOLDOWN_HOURS = 12;

/**
 * Fire-and-forget: recompute metrics after a tick and raise notifications for
 * any threshold breach. Deduplicated on the alert key, same as leg alerts.
 */
export function maybeRaiseReconMetricAlerts(params: {
  userId: string;
  portfolioId: string;
  portfolioName?: string | null;
  windowDays?: number;
  nowMs?: number;
}): void {
  if (!params.userId || !params.portfolioId) return;
  void (async () => {
    try {
      const summary = await buildReconMetrics({
        userId: params.userId,
        portfolioId: params.portfolioId,
        windowDays: params.windowDays ?? 14,
        ...(params.nowMs != null ? { nowMs: params.nowMs } : {}),
      });
      if (summary.alerts.length === 0) return;

      const nowIso = new Date(params.nowMs ?? Date.now()).toISOString();
      const cooldownSince = new Date(
        (params.nowMs ?? Date.now()) - ALERT_COOLDOWN_HOURS * 3600_000,
      ).toISOString();
      const { data: recent } = await supabaseAdmin
        .from("notifications")
        .select("details")
        .eq("user_id", params.userId)
        .eq("category", "recon_metrics")
        .eq("portfolio_id", params.portfolioId)
        .gte("created_at", cooldownSince)
        .limit(200);
      const seen = new Set<string>();
      for (const n of recent ?? []) {
        const k = (n.details as { alert_key?: unknown } | null)?.alert_key;
        if (typeof k === "string") seen.add(k);
      }

      const fresh = summary.alerts.filter((a) => !seen.has(a.key));
      if (fresh.length === 0) return;

      const { error } = await supabaseAdmin.from("notifications").insert(
        fresh.map((a) => ({
          user_id: params.userId,
          category: "recon_metrics",
          severity: a.severity,
          title: a.title,
          body: a.detail,
          portfolio_id: params.portfolioId,
          details: {
            alert_key: a.key,
            code: a.code,
            value: a.value,
            threshold: a.threshold,
            window_days: summary.windowDays,
            totals: { ...summary.totals, byCode: { ...summary.totals.byCode } },
            trend: { ...summary.trend },
            raised_at: nowIso,
            portfolio_name: params.portfolioName ?? null,
          } as unknown as Json,
        })),
      );
      if (error) throw error;
    } catch (e) {
      console.warn(
        "recon metric alerts failed",
        e instanceof Error ? e.message : String(e),
      );
    }
  })();
}
