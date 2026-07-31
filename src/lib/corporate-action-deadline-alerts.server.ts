// Cron-side scanner for corporate-action deadline countdowns.
//
// Walks every broker-linked portfolio, pulls Saxo's pending events, and pushes
// one notification per (event, threshold) crossing. Dedupe is a unique row in
// public.corporate_action_alerts_sent, so a re-run — or overlapping cron
// ticks — can never double-notify.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  DEFAULT_THRESHOLD_HOURS,
  alertKey,
  dueDeadlineAlerts,
  normalizeThresholds,
  type DeadlineAlertEvent,
} from "@/lib/corporate-action-deadline-alerts";

export type DeadlineScanResult = {
  portfolios: number;
  scanned: number;
  fired: number;
  suppressed: number;
  errors: string[];
  details: Array<{
    portfolioId: string;
    eventId: string;
    thresholdHours: number;
    hoursRemaining: number;
    sent: number;
  }>;
};

async function loadThresholds(userId: string): Promise<number[] | null> {
  const { data } = await supabaseAdmin
    .from("corporate_action_alert_settings")
    .select("enabled, threshold_hours")
    .eq("user_id", userId)
    .maybeSingle();
  if (data && data.enabled === false) return null; // opted out
  return normalizeThresholds(data?.threshold_hours ?? [...DEFAULT_THRESHOLD_HOURS]);
}

export async function runCorporateActionDeadlineAlerts(
  now = new Date(),
): Promise<DeadlineScanResult> {
  const result: DeadlineScanResult = {
    portfolios: 0,
    scanned: 0,
    fired: 0,
    suppressed: 0,
    errors: [],
    details: [],
  };

  const { data: portfolios, error } = await supabaseAdmin
    .from("portfolios")
    .select("id, name, mode, broker, broker_account_id, user_id");
  if (error) {
    result.errors.push(`portfolios read failed: ${error.message}`);
    return result;
  }

  const { resolvePortfolioBrokerLink } = await import(
    "@/lib/brokers/portfolio-broker-link.server"
  );
  const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
  const { normalizeCorporateActions } = await import("@/lib/corporate-actions");
  const { sendPushToUser } = await import("@/lib/push.server");

  const thresholdCache = new Map<string, number[] | null>();

  for (const p of portfolios ?? []) {
    const link = resolvePortfolioBrokerLink(p);
    if (!link.linked) continue;
    result.portfolios += 1;

    const userId = p.user_id as string;
    if (!thresholdCache.has(userId)) {
      thresholdCache.set(userId, await loadThresholds(userId));
    }
    const thresholds = thresholdCache.get(userId);
    if (!thresholds) continue; // alerts disabled for this user

    let events: DeadlineAlertEvent[] = [];
    try {
      const adapter = await buildSaxoAdapter({
        userId,
        portfolioId: p.id,
        envOverride: p.mode === "live_prod" ? "live" : "sim",
        accountKey: link.accountKey,
      });
      const res = await adapter.listCorporateActions();
      if (!res.supported) continue;
      events = normalizeCorporateActions(res.events)
        .filter((e) => e.accountKey == null || e.accountKey === link.accountKey)
        .map((e) => ({
          id: e.id,
          instrument: e.instrument,
          symbol: e.symbol,
          eventTypeLabel: e.eventTypeLabel,
          deadline: e.deadline,
          requiresElection: e.requiresElection,
        }));
    } catch (e) {
      result.errors.push(`${p.id}: ${(e as Error).message}`);
      continue;
    }
    result.scanned += events.length;
    if (events.length === 0) continue;

    // Which (event, threshold) pairs have already been handled?
    const { data: sentRows } = await supabaseAdmin
      .from("corporate_action_alerts_sent")
      .select("event_id, threshold_hours")
      .eq("user_id", userId)
      .in("event_id", events.map((e) => e.id));
    const alreadySent = new Set(
      (sentRows ?? []).map((r) => alertKey(r.event_id, r.threshold_hours)),
    );

    const due = dueDeadlineAlerts({
      events,
      thresholds,
      now,
      alreadySent,
      portfolioName: (p.name as string | null) ?? null,
    });

    for (const alert of due) {
      // Claim the slot first: if the unique constraint rejects it, another
      // tick already sent this one and we must not push again.
      const claim = await supabaseAdmin
        .from("corporate_action_alerts_sent")
        .insert({
          user_id: userId,
          portfolio_id: p.id,
          event_id: alert.eventId,
          threshold_hours: alert.thresholdHours,
          deadline: alert.deadline,
          hours_remaining: Number(alert.hoursRemaining.toFixed(3)),
          suppressed: false,
        })
        .select("id")
        .maybeSingle();
      if (!claim.data) continue;

      // Record the wider thresholds we intentionally skipped so they never
      // fire late.
      if (alert.suppressed.length) {
        await supabaseAdmin.from("corporate_action_alerts_sent").insert(
          alert.suppressed.map((t) => ({
            user_id: userId,
            portfolio_id: p.id,
            event_id: alert.eventId,
            threshold_hours: t,
            deadline: alert.deadline,
            hours_remaining: Number(alert.hoursRemaining.toFixed(3)),
            suppressed: true,
          })),
        );
        result.suppressed += alert.suppressed.length;
      }

      let sent = 0;
      try {
        const r = await sendPushToUser(userId, {
          title: alert.title,
          body: alert.body,
          url: `/portfolio/${p.id}`,
          tag: alert.tag,
          requireInteraction: alert.thresholdHours <= 24,
        });
        sent = r.sent;
      } catch (e) {
        result.errors.push(`push ${alert.eventId}: ${(e as Error).message}`);
      }
      result.fired += 1;
      result.details.push({
        portfolioId: p.id,
        eventId: alert.eventId,
        thresholdHours: alert.thresholdHours,
        hoursRemaining: alert.hoursRemaining,
        sent,
      });
    }
  }

  return result;
}
