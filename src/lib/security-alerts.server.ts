// Server-only helper: given a security_audit_log event that was just
// persisted, check the actor's SECURITY:pending_slices alert settings and
// send a push notification when the recent event count crosses the
// configured threshold and the cool-down has elapsed.
//
// Fire-and-forget: never let a notification failure disturb the caller.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendPushToUser } from "@/lib/push.server";

// Widened when the shared `_server/ownership` helper landed — the audit log
// now covers trading/live/attribution/holdings/insights/backtest as well.
export type AuditEventKind =
  | "pending_slices"
  | "trading"
  | "live"
  | "attribution"
  | "holdings"
  | "insights"
  | "backtest"
  | "cron_auth"
  | "generic";

export function maybeNotifySecurityEvent(params: {
  actorUserId: string | null;
  event: AuditEventKind;
  reason: string | null;
  portfolioId?: string | null;
}) {
  const userId = params.actorUserId;
  if (!userId) {
    // Actor-less rejections (unknown portfolio, missing ids, probing) still
    // matter — fan them out to the administrators instead of dropping them.
    notifyAdminsSecurityEvent({
      event: params.event,
      reason: params.reason,
      details: { portfolioId: params.portfolioId ?? null },
    });
    return;
  }

  void (async () => {
    try {
      const { data: settings } = await supabaseAdmin
        .from("security_alert_settings")
        .select("enabled, threshold, window_minutes, cooldown_minutes, last_notified_at, event_type")
        .eq("user_id", userId)
        .eq("event_type", params.event)
        .maybeSingle();
      if (!settings || !settings.enabled) return;

      const now = Date.now();
      const since = new Date(now - settings.window_minutes * 60_000).toISOString();

      const { count, error: countErr } = await supabaseAdmin
        .from("security_audit_log")
        .select("id", { count: "exact", head: true })
        .eq("event", params.event)
        .eq("actor_user_id", userId)
        .gte("created_at", since);
      if (countErr) throw countErr;
      const total = count ?? 0;
      if (total < settings.threshold) return;

      // Cool-down: don't spam.
      if (settings.last_notified_at) {
        const last = new Date(settings.last_notified_at).getTime();
        if (now - last < settings.cooldown_minutes * 60_000) return;
      }

      const title = `Security alert: ${params.event}`;
      const body =
        `${total} SECURITY:${params.event} events in the last ${settings.window_minutes}m` +
        (params.reason ? ` (latest: ${params.reason})` : "");

      // In-app notification row (read/unread + timestamps live here).
      await supabaseAdmin.from("notifications").insert({
        user_id: userId,
        category: params.event,
        severity: total >= settings.threshold * 2 ? "critical" : "warning",
        title,
        body,
        portfolio_id: params.portfolioId ?? null,
        details: {
          count: total,
          window_minutes: settings.window_minutes,
          reason: params.reason ?? null,
        },
      });

      await sendPushToUser(userId, {
        title,
        body,
        url: "/admin",
        tag: `security-alert-${params.event}`,
        requireInteraction: true,
      });

      await supabaseAdmin
        .from("security_alert_settings")
        .update({
          last_notified_at: new Date(now).toISOString(),
          last_notified_count: total,
        })
        .eq("user_id", userId)
        .eq("event_type", params.event);
    } catch (e) {
      console.warn(
        "SECURITY:alert notify failed",
        e instanceof Error ? e.message : String(e),
      );
    }
  })();
}

// UI defaults for security_alert_settings. Lives in the .server sidecar so
// the .functions.ts wrapper stays a thin server-fn module.
export const SECURITY_ALERT_DEFAULTS = {
  enabled: true,
  event_type: "pending_slices" as const,
  threshold: 5,
  window_minutes: 60,
  cooldown_minutes: 30,
  last_notified_at: null as string | null,
  last_notified_count: null as number | null,
};

/**
 * Admin fan-out for security events that have no owning user: repeated 401s on
 * the scheduled-job webhooks (`cron_auth`) and rejected access to a portfolio
 * we could not attribute to an actor.
 *
 * Counts matching `security_audit_log` rows inside the window, applies a
 * notification-backed cool-down so an ongoing probe cannot spam, then writes an
 * in-app notification AND a push alert to every administrator.
 *
 * Fire-and-forget: never let alerting break the access-control decision.
 */
export function notifyAdminsSecurityEvent(params: {
  event: AuditEventKind;
  reason: string | null;
  windowMinutes?: number;
  threshold?: number;
  cooldownMinutes?: number;
  details?: Record<string, unknown>;
}): void {
  const windowMinutes = params.windowMinutes ?? ADMIN_ALERT_DEFAULTS.windowMinutes;
  const threshold = params.threshold ?? ADMIN_ALERT_DEFAULTS.threshold;
  const cooldownMinutes =
    params.cooldownMinutes ?? ADMIN_ALERT_DEFAULTS.cooldownMinutes;

  void (async () => {
    try {
      const now = Date.now();
      const since = new Date(now - windowMinutes * 60_000).toISOString();
      const { count } = await supabaseAdmin
        .from("security_audit_log")
        .select("id", { count: "exact", head: true })
        .eq("event", params.event)
        .gte("created_at", since);
      const total = count ?? 0;
      if (total < threshold) return;

      const cooldownSince = new Date(now - cooldownMinutes * 60_000).toISOString();
      const { count: recentAlerts } = await supabaseAdmin
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("category", params.event)
        .gte("created_at", cooldownSince);
      if ((recentAlerts ?? 0) > 0) return;

      const { data: admins } = await supabaseAdmin
        .from("user_roles")
        .select("user_id")
        .eq("role", "admin");
      if (!admins?.length) return;

      const title =
        params.event === "cron_auth"
          ? "Unauthorised webhook attempts"
          : `Security alert: ${params.event}`;
      const body =
        `${total} SECURITY:${params.event} events in the last ${windowMinutes}m` +
        (params.reason ? ` (latest: ${params.reason})` : "");

      for (const admin of admins) {
        await supabaseAdmin.from("notifications").insert({
          user_id: admin.user_id,
          category: params.event,
          severity: total >= threshold * 2 ? "critical" : "warning",
          title,
          body,
          details: { ...(params.details ?? {}), count: total, window_minutes: windowMinutes },
        });
        await sendPushToUser(admin.user_id, {
          title,
          body,
          url: "/admin",
          tag: `security-alert-${params.event}`,
          requireInteraction: true,
        });
      }
    } catch (e) {
      console.warn(
        "SECURITY:admin alert notify failed",
        e instanceof Error ? e.message : String(e),
      );
    }
  })();
}

/** Defaults for the admin fan-out path (probing is rarer, alert sooner). */
export const ADMIN_ALERT_DEFAULTS = {
  threshold: 5,
  windowMinutes: 15,
  cooldownMinutes: 60,
};
