// Cron hook: advances any running historical news backfill by one slice.
// Kept separate from the live news refresh so a long history sweep can never
// delay today's headlines.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/news-backfill")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:news-backfill",
          capacity: 12,
          refillPerSec: 12 / 3600,
        });
        if (!verified.ok) return verified.response;

        try {
          const { advanceNewsBackfill } = await import("@/lib/news-backfill.server");
          const result = await advanceNewsBackfill({ budgetMs: 60_000 });
          console.log(
            `news-backfill: ${result.domains_processed} feeds swept, ${result.inserted} headlines added${result.done ? " (done)" : ""}`,
          );
          return new Response(JSON.stringify({ success: true, ...result }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("news-backfill: hook failed", message);
          return new Response(JSON.stringify({ success: false, error: message }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
      },
    },
  },
});
