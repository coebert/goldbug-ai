// Cron-triggered gateway health probe. Runs every ~15 minutes.
// Sends a tiny probe request to the Lovable AI Gateway, classifies any
// failure, and pushes a browser notification (deduped once per kind per UK
// day) so the operator knows within 15 minutes when trading is blocked and
// exactly what remedy is required — instead of noticing a day later that
// no BUYs were placed.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/ai-gateway-health")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:ai-gateway-health",
          capacity: 20,
          refillPerSec: 20 / 3600,
        });
        if (!verified.ok) return verified.response;

        const { probeAiGateway } = await import("@/lib/ai-gateway-health.server");
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        // UK-local YYYY-MM-DD for dedupe (Europe/London handles GMT/BST auto)
        const alertDateFmt = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
        });

        const verdict = await probeAiGateway();

        if (!verdict.actionable) {
          return Response.json({ ok: true, verdict, alerted: false, reason: "not actionable" });
        }

        const alertDate = londonDateISO(new Date());
        // Dedupe: (kind, alert_date). If a row exists, skip push.
        const ins = await supabaseAdmin
          .from("ai_gateway_health_alerts")
          .insert({ kind: verdict.kind, alert_date: alertDate, detail: verdict.detail })
          .select("id");

        if (ins.error) {
          const dup = ins.error.code === "23505" || /duplicate/i.test(ins.error.message);
          return Response.json({ ok: true, verdict, alerted: false, reason: dup ? "deduped" : ins.error.message });
        }

        const { sendPushToUser } = await import("@/lib/push.server");
        const { data: subs } = await supabaseAdmin.from("push_subscriptions").select("user_id");
        const userIds = Array.from(new Set((subs ?? []).map((r) => r.user_id)));

        const titleByKind: Record<string, string> = {
          credit_hard_block: "⚠️ AI Gateway: Credits exhausted",
          unauthorized: "⚠️ AI Gateway: Key rejected",
          rate_limited: "AI Gateway rate-limited",
          upstream_5xx: "AI Gateway upstream errors",
          network: "AI Gateway unreachable",
          unknown: "AI Gateway unhealthy",
        };
        const title = titleByKind[verdict.kind] ?? "AI Gateway unhealthy";
        let sent = 0, failed = 0;
        for (const uid of userIds) {
          try {
            const r = await sendPushToUser(uid, {
              title,
              body: verdict.remedy,
              tag: `ai-gateway-health:${verdict.kind}:${alertDate}`,
              requireInteraction: true,
              url: "/admin",
            });
            sent += r.sent; failed += r.failed;
          } catch (e) {
            failed++;
            console.warn("push send failed", e);
          }
        }

        return Response.json({ ok: true, verdict, alerted: true, sent, failed });
      },
    },
  },
});
