// Cron endpoint: scan Saxo corporate-action deadlines and push countdown
// reminders (default 72h / 24h / 4h before the election deadline).
// Scheduled every 15 minutes via pg_cron; dedupe lives in the database.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/corporate-action-deadlines")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:corporate-action-deadlines",
          capacity: 20,
          refillPerSec: 20 / 3600,
        });
        if (!verified.ok) return verified.response;

        const { runCorporateActionDeadlineAlerts } = await import(
          "@/lib/corporate-action-deadline-alerts.server"
        );
        try {
          const result = await runCorporateActionDeadlineAlerts(new Date());
          return Response.json({ success: true, ...result });
        } catch (e) {
          console.error("corporate-action-deadlines: scan failed", e);
          return new Response(JSON.stringify({ error: (e as Error).message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
