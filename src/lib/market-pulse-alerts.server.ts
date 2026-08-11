// Delivers Market pulse alerts: in-app notification row + web push, with a
// signature-based cool-down so an unchanged condition only notifies once.
//
// Fire-and-forget — dashboard reads must never fail because a push failed.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendPushToUser } from "@/lib/push.server";
import {
  PULSE_ALERT_THRESHOLDS,
  pulseAlertsSignature,
  type PulseAlert,
} from "@/lib/market-pulse-alerts";

const COOLDOWN_HOURS = 6;

export async function maybeNotifyPulseAlerts(params: {
  userId: string | null;
  alerts: PulseAlert[];
  asOf: string | null;
}): Promise<void> {
  const { userId, alerts, asOf } = params;
  if (!userId || alerts.length === 0) return;

  try {
    const signature = pulseAlertsSignature(alerts);
    const since = new Date(Date.now() - COOLDOWN_HOURS * 3600_000).toISOString();
    const { data: recent } = await supabaseAdmin
      .from("notifications")
      .select("id, details")
      .eq("user_id", userId)
      .eq("category", "market_pulse")
      .gte("created_at", since)
      .limit(10);
    const alreadySent = (recent ?? []).some(
      (r) => ((r.details ?? {}) as { signature?: string }).signature === signature,
    );
    if (alreadySent) return;

    const critical = alerts.filter((a) => a.severity === "critical");
    const lead = critical[0] ?? alerts[0];
    const severity = critical.length ? "critical" : "warning";
    const title =
      alerts.length === 1 ? lead.title : `${lead.title} (+${alerts.length - 1} more)`;
    const body = alerts
      .map((a) => `${a.metric}: ${a.valueText} (alert at ${a.thresholdText})`)
      .join(" · ");

    await supabaseAdmin.from("notifications").insert({
      user_id: userId,
      category: "market_pulse",
      severity,
      title,
      body,
      details: {
        signature,
        as_of: asOf,
        thresholds: PULSE_ALERT_THRESHOLDS,
        alerts: alerts.map((a) => ({
          id: a.id,
          severity: a.severity,
          metric: a.metric,
          value: a.value,
          value_text: a.valueText,
          threshold: a.threshold,
          threshold_text: a.thresholdText,
          symbol: a.symbol ?? null,
          body: a.body,
        })),
      },
    });

    try {
      await sendPushToUser(userId, {
        title,
        body,
        url: lead.symbol ? `/market/${encodeURIComponent(lead.symbol)}` : "/",
        tag: "market-pulse-alert",
        requireInteraction: severity === "critical",
      });
    } catch (e) {
      console.warn("market-pulse push failed", e instanceof Error ? e.message : String(e));
    }
  } catch (e) {
    console.warn("market-pulse-notify failed", e instanceof Error ? e.message : String(e));
  }
}
