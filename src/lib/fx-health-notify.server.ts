// Out-of-UI notifier for FX endpoint failures. Fires when the executor's
// most recent FX_CAPTURE for a portfolio resolved to an identity fallback
// (rate=1, source starts with "fallback:") — i.e. BOTH Yahoo and Frankfurter
// failed — or when identity fallbacks pile up inside a short window.
//
// Delivery follows the same pattern as maybeNotifyPrecheckCashReject:
// in-app notification row + optional webhook POST, cool-down enforced via
// the notification's own created_at so no extra table is needed. Runs
// fire-and-forget so it never disturbs the trading tick.
//
// Configuration (reuses the precheck webhook secrets when set — one URL
// for all trading alerts is the common case, but can be overridden):
//   FX_ALERT_WEBHOOK_URL         optional; falls back to PRECHECK_ALERT_WEBHOOK_URL
//   FX_ALERT_WEBHOOK_TOKEN       optional; falls back to PRECHECK_ALERT_WEBHOOK_TOKEN

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const THRESHOLD = 2; // 2 identity fallbacks in the window trips the alert
const WINDOW_HOURS = 6;
const COOLDOWN_HOURS = 6;

export function maybeNotifyFxUnhealthy(params: {
  portfolioId: string | null;
  userId: string | null;
  pair: string; // e.g. "GBP->EUR"
  rate: number;
  source: string;
  stale: boolean;
}) {
  const { portfolioId, userId, pair, rate, source, stale } = params;
  if (!portfolioId || !userId) return;
  // Only trip on a hard identity fallback — cache or cache-stale still gives
  // the executor a real-ish rate, so we don't want to spam the operator.
  const isIdentityFallback =
    source.startsWith("fallback") || (source === "identity" && pair !== "unknown");
  if (!isIdentityFallback) return;

  void (async () => {
    try {
      const now = Date.now();
      const sinceIso = new Date(now - WINDOW_HOURS * 3600_000).toISOString();

      const { data: rows, error } = await supabaseAdmin
        .from("live_broker_log")
        .select("created_at, response")
        .eq("portfolio_id", portfolioId)
        .eq("method", "FX_CAPTURE")
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;

      let fallbackCount = 0;
      for (const r of rows ?? []) {
        const resp = (r.response ?? {}) as { source?: string };
        const s = resp.source ?? "";
        if (s.startsWith("fallback")) fallbackCount += 1;
      }
      if (fallbackCount < THRESHOLD) return;

      const cooldownSince = new Date(now - COOLDOWN_HOURS * 3600_000).toISOString();
      const { data: recent } = await supabaseAdmin
        .from("notifications")
        .select("id")
        .eq("user_id", userId)
        .eq("category", "fx_unhealthy")
        .eq("portfolio_id", portfolioId)
        .gte("created_at", cooldownSince)
        .limit(1);
      if (recent && recent.length > 0) return;

      const title = "FX rates unavailable — cross-currency trades at risk";
      const body =
        `Both Yahoo and Frankfurter failed on ${fallbackCount} FX lookup${fallbackCount === 1 ? "" : "s"} in the last ${WINDOW_HOURS}h. ` +
        `Latest ${pair} used a fallback rate of ${rate.toFixed(4)} (source: ${source}). ` +
        `Cross-currency buys will be blocked until a live rate returns.`;

      await supabaseAdmin.from("notifications").insert({
        user_id: userId,
        category: "fx_unhealthy",
        severity: fallbackCount >= THRESHOLD * 2 ? "critical" : "warning",
        title,
        body,
        portfolio_id: portfolioId,
        details: {
          pair,
          latest_rate: rate,
          latest_source: source,
          stale,
          fallback_count: fallbackCount,
          window_hours: WINDOW_HOURS,
        },
      });

      const url = process.env.FX_ALERT_WEBHOOK_URL ?? process.env.PRECHECK_ALERT_WEBHOOK_URL;
      if (url) {
        const token = process.env.FX_ALERT_WEBHOOK_TOKEN ?? process.env.PRECHECK_ALERT_WEBHOOK_TOKEN;
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
              event: "fx.unhealthy_threshold",
              portfolioId,
              userId,
              pair,
              latestRate: rate,
              latestSource: source,
              stale,
              fallbackCount,
              windowHours: WINDOW_HOURS,
              threshold: THRESHOLD,
              at: new Date(now).toISOString(),
            }),
          });
          if (!res.ok) console.warn("fx-health-notify webhook non-2xx", res.status);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (e) {
      console.warn(
        "fx-health-notify failed",
        e instanceof Error ? e.message : String(e),
      );
    }
  })();
}
