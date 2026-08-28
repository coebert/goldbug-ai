// Cron-triggered endpoint that scans every alertable venue and pushes a
// browser notification the first time it flips from closed → open on a given
// UK day. Dedupe is enforced by a unique row in public.market_open_alerts_sent
// so re-running the cron (or drift between scheduled ticks) can never
// double-notify. Called every 10 minutes via pg_cron — safe because
// `detectRecentOpenings` looks back 15 minutes, so no opening falls through
// the gap even if a tick is skipped.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/market-open-alerts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:market-open-alerts",
          capacity: 30,
          refillPerSec: 30 / 3600,
        });
        if (!verified.ok) return verified.response;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { detectRecentOpenings } = await import("@/lib/market-open-alerts.server");
        const { sendPushToUser } = await import("@/lib/push.server");

        const now = new Date();
        const openings = detectRecentOpenings(now, 15);
        if (openings.length === 0) {
          return Response.json({ success: true, alerts: 0, message: "no openings in window" });
        }

        // Fetch every user with at least one push subscription — this is a
        // single-user app in practice, but the loop stays generic so the
        // moment we onboard another subscriber it just works.
        const { data: subUsers, error: subErr } = await supabaseAdmin
          .from("push_subscriptions")
          .select("user_id");
        if (subErr) {
          return new Response(JSON.stringify({ error: subErr.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        const userIds = Array.from(new Set((subUsers ?? []).map((r) => r.user_id)));

        const results: Array<{
          venue: string;
          date: string;
          fired: boolean;
          reason?: string;
          sent?: number;
          removed?: number;
          failed?: number;
        }> = [];

        for (const ev of openings) {
          // Insert dedupe row; unique (venue, alert_date). If it already
          // exists, PostgREST returns an empty array and we skip.
          const ins = await supabaseAdmin
            .from("market_open_alerts_sent")
            .insert({
              venue: ev.market.id,
              alert_date: ev.ukAlertDate,
              sent_at: new Date().toISOString(),
            })
            .select("venue")
            .maybeSingle();

          if (!ins.data) {
            results.push({ venue: ev.market.id, date: ev.ukAlertDate, fired: false, reason: "already sent" });
            continue;
          }

          if (userIds.length === 0) {
            results.push({ venue: ev.market.id, date: ev.ukAlertDate, fired: true, reason: "no subscribers", sent: 0, removed: 0, failed: 0 });
            continue;
          }

          const title = `${ev.market.label} is open`;
          const body = `Trading opened at ${ev.ukOpenTimeLabel}. Aegis can now route orders on this venue.`;
          const tag = `market-open:${ev.market.id}:${ev.ukAlertDate}`;

          let sent = 0, removed = 0, failed = 0;
          for (const uid of userIds) {
            try {
              const r = await sendPushToUser(uid, { title, body, url: "/", tag });
              sent += r.sent;
              removed += r.removed;
              failed += r.failed;
            } catch (e) {
              console.error("market-open-alerts: push failed", uid, e);
              failed += 1;
            }
          }
          results.push({ venue: ev.market.id, date: ev.ukAlertDate, fired: true, sent, removed, failed });
        }

        return Response.json({ success: true, alerts: results.length, results });
      },
    },
  },
});
