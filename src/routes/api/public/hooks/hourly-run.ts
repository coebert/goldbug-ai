// Cron-triggered endpoint that runs an hourly AI market + news check.
// Refreshes news + macro regime + latest prices, then runs a tick for every
// paper-mode portfolio (multiple ticks per day are safe — snapshots upsert).
// Auth via Lovable Cloud apikey header (legacy x-cron-secret remains accepted).

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
        const task = runHourlyCycle({
            triggeredBy: manualTrigger ? "manual" : "cron",
            force: forceClear,
          })
          .then((result) => {
            console.log(
              `hourly-run: background cycle finished (${result.news_headlines} headlines, ${result.portfolios} portfolios)`,
            );
          })
          .catch((error) => {
          if (error instanceof RunInProgressError) {
              console.warn("hourly-run: background cycle skipped", {
                message: error.message,
                held_by: error.heldBy,
                acquired_at: error.acquiredAt,
                age_ms: error.ageMs,
              });
              return;
          }
            console.error("hourly-run: background cycle failed", error);
          });

        const ctx = (globalThis as unknown as { __cfCtx?: { waitUntil?: (p: Promise<unknown>) => void } }).__cfCtx;
        try {
          ctx?.waitUntil?.(task);
        } catch {
          // In local/dev runtimes the promise continues on the event loop.
        }

        return new Response(
          JSON.stringify({
            success: true,
            started: true,
            triggered_by: manualTrigger ? "manual" : "cron",
            force: forceClear,
            at: new Date().toISOString(),
          }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
