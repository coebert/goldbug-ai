import { createFileRoute } from "@tanstack/react-router";

// Cron endpoint: evaluate every active ticker watch against fresh prices and
// push deduped alerts when an entry / invalidation condition trips.
export const Route = createFileRoute("/api/public/hooks/ticker-watch")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:ticker-watch",
          capacity: 20,
          refillPerSec: 20 / 3600,
        });
        if (!verified.ok) return verified.response;

        const { runTickerWatchScan } = await import("@/lib/ticker-watch.server");
        try {
          return Response.json({ success: true, ...(await runTickerWatchScan()) });
        } catch (e) {
          console.error("ticker-watch: scan failed", e);
          return new Response(JSON.stringify({ error: (e as Error).message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
