// Cron-triggered valuation drift reconciliation. Runs once daily.
//
// Recomputes each portfolio's most recent equity snapshot from live holdings,
// prices, and FX, and compares it to the stored figure. Drift means a snapshot
// went stale or was written from bad source data — the two ways a wrong number
// can still reach a tile after the write gate has done its job.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/valuation-drift")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:valuation-drift",
          capacity: 10,
          refillPerSec: 10 / 86400,
        });
        if (!verified.ok) return verified.response;

        const { reconcileValuationDrift } = await import("@/lib/valuation/reconcile-drift.server");
        const rows = await reconcileValuationDrift();
        const notable = rows.filter((r) => r.severity !== "ok");

        if (notable.length > 0) {
          try {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const { sendPushToUser } = await import("@/lib/push.server");
            const { data: subs } = await supabaseAdmin.from("push_subscriptions").select("user_id");
            const userIds = Array.from(new Set((subs ?? []).map((r) => r.user_id)));
            const worst = notable.find((r) => r.severity === "alert") ?? notable[0]!;
            const pct = (worst.diffPct * 100).toFixed(1);
            for (const uid of userIds) {
              await sendPushToUser(uid, {
                title: "⚠️ Portfolio valuation drift",
                body: `${worst.portfolioName}: stored snapshot differs from a fresh recomputation by ${pct}%.`,
                tag: `valuation-drift:${worst.portfolioId}:${worst.snapshotDate}`,
                url: "/",
              });
            }
          } catch (e) {
            console.warn("valuation-drift push failed", e);
          }
        }

        return Response.json({
          ok: true,
          checked: rows.length,
          drifted: notable.length,
          rows,
        });
      },
    },
  },
});
