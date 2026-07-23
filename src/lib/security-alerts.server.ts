// Server-only helper: given a security_audit_log event that was just
// persisted, check the actor's SECURITY:pending_slices alert settings and
// send a push notification when the recent event count crosses the
// configured threshold and the cool-down has elapsed.
//
// Fire-and-forget: never let a notification failure disturb the caller.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendPushToUser } from "@/lib/push.server";

type AuditEventKind = "pending_slices";

export function maybeNotifySecurityEvent(params: {
  actorUserId: string | null;
  event: AuditEventKind;
  reason: string | null;
  portfolioId?: string | null;
}) {
  const userId = params.actorUserId;
  if (!userId) return; // Cannot notify without an owner.
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

      const title = "Security alert: pending_slices";
      const body =
        `${total} SECURITY:${params.event} events in the last ${settings.window_minutes}m` +
        (params.reason ? ` (latest: ${params.reason})` : "");
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
