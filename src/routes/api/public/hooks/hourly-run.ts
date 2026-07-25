// Cron-triggered endpoint that runs an hourly AI market + news check.
// Refreshes news + macro regime + latest prices, then runs a tick for every
// paper-mode portfolio (multiple ticks per day are safe — snapshots upsert).
// Auth via Supabase anon apikey header.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/hourly-run")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:hourly-run",
          capacity: 10,
          refillPerSec: 10/3600,
        });
        if (!verified.ok) return verified.response;
        let manualTrigger = false;
        let forceClear = false;
        try {
          const bodyText = await request.clone().text();
          if (bodyText) {
            const parsed = JSON.parse(bodyText);
            manualTrigger = parsed?.manual === true;
            forceClear = parsed?.force === true;
          }
        } catch { /* body optional */ }
        const { runHourlyCycle, RunInProgressError } = await import("@/lib/hourly-run.server");
        try {
          const result = await runHourlyCycle({
            triggeredBy: manualTrigger ? "manual" : "cron",
            force: forceClear,
          });
          return Response.json(result);
        } catch (error) {
          if (error instanceof RunInProgressError) {
            return new Response(
              JSON.stringify({
                error: "run_in_progress",
                message: error.message,
                held_by: error.heldBy,
                acquired_at: error.acquiredAt,
                age_ms: error.ageMs,
              }),
              { status: 409, headers: { "Content-Type": "application/json" } },
            );
          }
          const message = error instanceof Error ? error.message : String(error);
          return new Response(
            JSON.stringify({ error: message }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      },
    },
  },
});
