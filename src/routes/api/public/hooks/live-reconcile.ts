// Cron-triggered nightly reconciliation for every live portfolio.
// Requires x-cron-secret header (same as daily/hourly hooks).

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/live-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { checkRateLimit, tooManyRequests } = await import("@/lib/rate-limit.server");
        const rl = await checkRateLimit(request, {
          bucket: "hooks:live-reconcile",
          capacity: 5,
          refillPerSec: 5 / 3600,
        });
        if (!rl.allowed) return tooManyRequests(rl);

        const provided = request.headers.get("x-cron-secret") ?? request.headers.get("X-Cron-Secret");
        const expected = process.env.CRON_SECRET;
        if (!expected || provided !== expected) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401, headers: { "Content-Type": "application/json" },
          });
        }
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
