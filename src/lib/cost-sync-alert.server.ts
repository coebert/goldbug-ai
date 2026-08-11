// Fire-and-forget notifier for broker charge-report failures / partial
// coverage during the hourly run. Mirrors the FX-health notifier: an in-app
// notification row (which the dashboard banner reads) plus an optional
// webhook, with the cool-down enforced off the notification's own created_at
// so no extra table is needed.
//
//   COST_SYNC_ALERT_WEBHOOK_URL    optional; falls back to PRECHECK_ALERT_WEBHOOK_URL
//   COST_SYNC_ALERT_WEBHOOK_TOKEN  optional; falls back to PRECHECK_ALERT_WEBHOOK_TOKEN

import { evaluateCostSyncHealth, type CostSyncInput } from "./cost-sync-health";

export const COST_SYNC_ALERT_CATEGORY = "broker_cost_sync";
const COOLDOWN_HOURS = 6;

export function maybeNotifyCostSyncHealth(params: {
  portfolioId: string;
  userId: string;
  portfolioName?: string | null;
  result: CostSyncInput;
}) {
  const { portfolioId, userId, portfolioName } = params;
  if (!portfolioId || !userId) return;

  const health = evaluateCostSyncHealth(params.result);
  if (!health.shouldAlert) return;

  void (async () => {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const now = Date.now();
      const cooldownSince = new Date(now - COOLDOWN_HOURS * 3600_000).toISOString();

      const { data: recent } = await supabaseAdmin
        .from("notifications")
        .select("id, details")
        .eq("user_id", userId)
        .eq("category", COST_SYNC_ALERT_CATEGORY)
        .eq("portfolio_id", portfolioId)
        .gte("created_at", cooldownSince)
        .limit(1);
      // Let a hard failure through even inside the cool-down if the previous
      // alert was only a partial-coverage warning — an escalation is news.
      const prevStatus = (recent?.[0]?.details as { status?: string } | undefined)?.status;
      const escalated = health.status === "failed" && prevStatus === "partial";
      if (recent && recent.length > 0 && !escalated) return;

      const label = portfolioName ? ` (${portfolioName})` : "";
      await supabaseAdmin.from("notifications").insert({
        user_id: userId,
        category: COST_SYNC_ALERT_CATEGORY,
        severity: health.severity,
        title: `${health.title}${label}`,
        body: health.body,
        portfolio_id: portfolioId,
        details: {
          status: health.status,
          coverage_pct: health.coveragePct,
          fills_considered: params.result.fillsConsidered,
          fills_updated: params.result.fillsUpdated,
          unmatched_fills: params.result.unmatchedFills,
          error: params.result.error ?? null,
          reason: params.result.reason ?? null,
        },
      });

      const url =
        process.env["COST_SYNC_ALERT_WEBHOOK_URL"] ?? process.env["PRECHECK_ALERT_WEBHOOK_URL"];
      if (url) {
        const token =
          process.env["COST_SYNC_ALERT_WEBHOOK_TOKEN"] ??
          process.env["PRECHECK_ALERT_WEBHOOK_TOKEN"];
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (token) headers["authorization"] = `Bearer ${token}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5_000);
        try {
          const res = await fetch(url, {
            method: "POST",
            headers,
            signal: ctrl.signal,
            body: JSON.stringify({
              event: "broker.cost_sync_unhealthy",
              status: health.status,
              portfolioId,
              userId,
              coveragePct: health.coveragePct,
              fillsConsidered: params.result.fillsConsidered,
              fillsUpdated: params.result.fillsUpdated,
              unmatchedFills: params.result.unmatchedFills,
              error: params.result.error ?? null,
              at: new Date(now).toISOString(),
            }),
          });
          if (!res.ok) console.warn("cost-sync-alert webhook non-2xx", res.status);
          await res.body?.cancel().catch(() => undefined);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (e) {
      console.warn("cost-sync-alert failed", e instanceof Error ? e.message : String(e));
    }
  })();
}
