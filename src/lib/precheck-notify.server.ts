// Out-of-UI notifier for cash-side Saxo precheck rejections. Mirrors the
// threshold logic used by the in-app PrecheckCashAlertBanner so the user
// gets an in-app notification row + optional webhook POST at the same
// moment the banner would appear — without having to keep the portfolio
// page open. Fire-and-forget: never let a notification failure disturb
// the caller (order placement continues either way).
//
// Configuration:
//   PRECHECK_ALERT_WEBHOOK_URL   optional; when set, JSON POSTed on trip
//   PRECHECK_ALERT_WEBHOOK_TOKEN optional; if set, sent as
//                                Authorization: Bearer <token>
//
// Delivery is deduplicated by writing an in-app notification row with
// category "precheck_cash" and using its `created_at` as the cool-down
// timestamp, so no extra table is required.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Match the UI banner exactly: three cash-side rejects in 24 hours.
const THRESHOLD = 3;
const WINDOW_HOURS = 24;
// Don't re-alert more than once every 6 hours per portfolio — long
// enough that a repeatedly-broken cron doesn't spam the webhook, short
// enough that the operator sees a fresh alert after resolving one round.
const COOLDOWN_HOURS = 6;

const CASH_CODE = /^(insufficient(cash|buyingpower)|nocashavailable)$/i;
const CASH_TEXT = /insufficient.*(cash|buying power|funds)|not enough (cash|funds)/i;

function isCashReject(code: string | null, message: string | null): boolean {
  if (code && CASH_CODE.test(code)) return true;
  if (message && CASH_TEXT.test(message)) return true;
  return false;
}

export function maybeNotifyPrecheckCashReject(params: {
  portfolioId: string | null;
  userId: string | null;
  code: string | null;
  message: string | null;
}) {
  const userId = params.userId;
  const portfolioId = params.portfolioId;
  if (!userId || !portfolioId) return;
  if (!isCashReject(params.code, params.message)) return;


  void (async () => {

    try {
      const now = Date.now();
      const sinceIso = new Date(now - WINDOW_HOURS * 3600_000).toISOString();

      // Count cash-side rejects for this portfolio in the window. We fetch
      // the raw rows (bounded) because the cash classification lives in the
      // `response` JSON, not a dedicated column.
      const { data: rows, error } = await supabaseAdmin
        .from("live_broker_log")
        .select("created_at, error, response")
        .eq("portfolio_id", portfolioId)
        .eq("method", "PRECHECK_REJECT")
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;

      let cashCount = 0;
      for (const r of rows ?? []) {
        const resp = (r.response ?? {}) as { ErrorCode?: string | null; Message?: string | null };
        if (isCashReject(resp.ErrorCode ?? null, resp.Message ?? r.error ?? null)) cashCount += 1;
      }
      if (cashCount < THRESHOLD) return;

      // Cool-down: check for a recent notification row for this portfolio.
      const cooldownSince = new Date(now - COOLDOWN_HOURS * 3600_000).toISOString();
      const { data: recent } = await supabaseAdmin
        .from("notifications")
        .select("id")
        .eq("user_id", userId)
        .eq("category", "precheck_cash")
        .eq("portfolio_id", portfolioId)
        .gte("created_at", cooldownSince)
        .limit(1);
      if (recent && recent.length > 0) return;

      const title = "Broker keeps rejecting buys for cash";
      const body =
        `${cashCount} cash-side precheck rejection${cashCount === 1 ? "" : "s"} in the last ${WINDOW_HOURS}h. ` +
        `Latest: ${params.message ?? params.code ?? "InsufficientCash"}.`;

      await supabaseAdmin.from("notifications").insert({
        user_id: userId,
        category: "precheck_cash",
        severity: cashCount >= THRESHOLD * 2 ? "critical" : "warning",
        title,
        body,
        portfolio_id: portfolioId,
        details: {
          count: cashCount,
          window_hours: WINDOW_HOURS,
          latest_code: params.code,
          latest_message: params.message,
        },
      });

      const url = process.env.PRECHECK_ALERT_WEBHOOK_URL;
      if (url) {
        const token = process.env.PRECHECK_ALERT_WEBHOOK_TOKEN;
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (token) headers.authorization = `Bearer ${token}`;
        // Fire the webhook with a short timeout so a stalled receiver
        // doesn't tie up the trading tick.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5_000);
        try {
          const res = await fetch(url, {
            method: "POST",
            headers,
            signal: ctrl.signal,
            body: JSON.stringify({
              event: "precheck.cash_reject_threshold",
              portfolioId: portfolioId,
              userId: userId,
              cashRejects: cashCount,
              windowHours: WINDOW_HOURS,
              threshold: THRESHOLD,
              latest: { code: params.code, message: params.message },
              at: new Date(now).toISOString(),
            }),
          });
          if (!res.ok) {
            console.warn("precheck-notify webhook non-2xx", res.status);
          }
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (e) {
      console.warn(
        "precheck-notify failed",
        e instanceof Error ? e.message : String(e),
      );
    }
  })();
}
