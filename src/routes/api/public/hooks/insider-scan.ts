import { createFileRoute } from "@tanstack/react-router";

// Cron endpoint: sweep director / PDMR dealings for held, watched and
// candidate names, then AI-review every new one so the trading engine gets a
// vetted insider signal instead of raw keyword matches.
export const Route = createFileRoute("/api/public/hooks/insider-scan")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:insider-scan",
          capacity: 12,
          refillPerSec: 12 / 3600,
        });
        if (!verified.ok) return verified.response;

        const { runInsiderAiScan } = await import("@/lib/insider-ai-scan.server");
        try {
          const result = await runInsiderAiScan({ trigger: "cron-hook" });
          return Response.json({ success: !result.error, ...result });
        } catch (e) {
          console.error("insider-scan: run failed", e);
          return new Response(JSON.stringify({ error: (e as Error).message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
