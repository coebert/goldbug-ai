// Cron-triggered endpoint that runs the AI daily tick for every paper-mode portfolio.
// Called by pg_cron once per day. Auth: private CRON_SECRET + HMAC signature.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/daily-run")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:daily-run",
          requireSignature: true,
          capacity: 5,
          refillPerSec: 5/3600,
        });
        if (!verified.ok) return verified.response;
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runDailyTick } = await import("@/lib/trading-engine.server");
        const { detectAndPersistRegime } = await import("@/lib/regime-detector.server");

        const today = new Date().toISOString().slice(0, 10);

        // Always refresh macro regime once per day, even if no portfolios are due.
        let regimeInfo: unknown = null;
        try {
          regimeInfo = await detectAndPersistRegime(today);
        } catch (e) {
          console.error("daily-run: regime detection failed", e);
        }
        const { data: portfolios, error } = await supabaseAdmin
          .from("portfolios")
          .select("id, name, last_run_date, mode")
          .eq("mode", "paper");

        if (error) {
          console.error("daily-run: fetch portfolios failed", error);
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const due = (portfolios ?? []).filter((p) => p.last_run_date !== today);
        const results: Array<{ id: string; ok: boolean; error?: string; value?: number }> = [];

        // Run sequentially to be gentle on rate limits & the AI gateway
        for (const p of due) {
          try {
            const r = await runDailyTick(p.id, today, { forceAi: true });
            results.push({ id: p.id, ok: true, value: r.totalValue });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`daily-run: portfolio ${p.id} failed`, msg);
            results.push({ id: p.id, ok: false, error: msg });
          }
        }

        return Response.json({
          success: true,
          date: today,
          total: portfolios?.length ?? 0,
          ran: results.length,
          regime: regimeInfo,
          results,
        });
      },
    },
  },
});
