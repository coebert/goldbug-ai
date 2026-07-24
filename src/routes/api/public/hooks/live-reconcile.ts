// Cron-triggered nightly reconciliation for every live portfolio.
// Requires x-cron-secret header (same as daily/hourly hooks).

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/live-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:live-reconcile",
          capacity: 5,
          refillPerSec: 5/3600,
        });
        if (!verified.ok) return verified.response;
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runReconciliation } = await import("@/lib/live.functions");
        const { data: portfolios, error } = await supabaseAdmin
          .from("portfolios").select("id, user_id, mode")
          .in("mode", ["live_sim", "live_prod"]);
        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500, headers: { "Content-Type": "application/json" },
          });
        }
        const results: Array<{ id: string; ok: boolean; drift?: boolean; error?: string }> = [];
        for (const p of portfolios ?? []) {
          try {
            const r = await runReconciliation(p.user_id, p.id);
            results.push({ id: p.id, ok: true, drift: "drift" in r ? r.drift : undefined });
          } catch (e) {
            results.push({ id: p.id, ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        }
        return Response.json({ success: true, at: new Date().toISOString(), results });
      },
    },
  },
});
