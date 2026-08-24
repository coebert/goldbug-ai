// Cron-triggered orphaned pending-order sweep for every live portfolio.
//
// Detects orders that are stuck open locally or resting far too long at the
// broker (the MKS.L sell case), cancels or reconciles them, and leaves the
// symbol free for the next trading tick.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/orphan-order-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:orphan-order-sweep",
          requireSignature: true,
          capacity: 10,
          refillPerSec: 10 / 3600,
        });
        if (!verified.ok) return verified.response;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { sweepOrphanOrdersForPortfolio } = await import("@/lib/orphan-order-sweep.server");
        const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
        const { resolvePortfolioBrokerLink } = await import(
          "@/lib/brokers/portfolio-broker-link.server"
        );

        const { data: portfolios, error } = await supabaseAdmin
          .from("portfolios")
          .select("*")
          .in("mode", ["live_sim", "live_prod"]);
        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const results: Array<Record<string, unknown>> = [];
        for (const p of portfolios ?? []) {
          try {
            const link = resolvePortfolioBrokerLink(p);
            if (!link.linked) throw new Error(link.reason);
            const env = p.mode === "live_prod" ? "live" : "sim";
            const adapter = await buildSaxoAdapter({
              userId: p.user_id as string,
              portfolioId: p.id,
              envOverride: env,
              accountKey: link.accountKey,
            });
            const r = await sweepOrphanOrdersForPortfolio({
              portfolioId: p.id,
              userId: p.user_id as string,
              adapter,
              env,
              source: "orphan-sweep-cron",
            });
            results.push({
              id: p.id,
              ok: true,
              scanned: r.scanned,
              cancelledAtBroker: r.cancelledAtBroker,
              cancelledUntracked: r.cancelledUntracked,
              closedLocally: r.closedLocally,
              failures: r.failures,
            });
          } catch (e) {
            results.push({ id: p.id, ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        }

        return Response.json({ success: true, at: new Date().toISOString(), results });
      },
    },
  },
});
