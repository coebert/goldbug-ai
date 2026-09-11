// Cron-triggered endpoint that runs an hourly AI market + news check.
// Refreshes news + macro regime + latest prices, then runs a tick for every
// paper-mode portfolio (multiple ticks per day are safe — snapshots upsert).
// Auth: private CRON_SECRET plus a timestamped HMAC signature (replay-resistant).

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/hourly-run")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:hourly-run",
          requireSignature: true,
          capacity: 10,
          refillPerSec: 10/3600,
        });
        if (!verified.ok) return verified.response;
        let manualTrigger = false;
        let forceClear = false;
        let forceTick = false;
        let portfolioIds: string[] | undefined;
        try {
          const bodyText = await request.clone().text();
          if (bodyText) {
            const parsed = JSON.parse(bodyText);
            manualTrigger = parsed?.manual === true;
            forceClear = parsed?.force === true;
            forceTick = parsed?.forceTick === true;
            // Optional scoping: a manual call may target specific portfolios
            // so one account can be ticked without waiting for the others.
            if (Array.isArray(parsed?.portfolioIds)) {
              portfolioIds = parsed.portfolioIds
                .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
                .slice(0, 50);
            }
          }
        } catch { /* body optional */ }
        const { runHourlyCycle, RunInProgressError } = await import("@/lib/hourly-run.server");

        // Run inline, but with a request-safe budget. Longer background work
        // has been observed getting dropped by the worker lifecycle, leaving
        // run_locks stuck; a bounded inline run is safer and releases locks.
        try {
          const result = await runHourlyCycle({
            triggeredBy: manualTrigger ? "manual" : "cron",
            force: forceClear,
            forceTick,
            ...(portfolioIds && portfolioIds.length > 0 ? { portfolioIds } : {}),
            timeBudgetMs: 55_000,
            skipNewsInTicks: true,
          });
          console.log(
            `hourly-run: cycle finished (${result.news_headlines} headlines, ${result.portfolios} portfolios)`,
          );
          return new Response(
            JSON.stringify({
              success: true,
              completed: true,
              triggered_by: manualTrigger ? "manual" : "cron",
              force: forceClear,
              at: new Date().toISOString(),
              portfolios: result.portfolios,
              news_headlines: result.news_headlines,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        } catch (error) {
          if (error instanceof RunInProgressError) {
            console.warn("hourly-run: cycle skipped", {
              message: error.message,
              held_by: error.heldBy,
              acquired_at: error.acquiredAt,
              age_ms: error.ageMs,
            });
            return new Response(
              JSON.stringify({
                success: true,
                skipped: "run-in-progress",
                held_by: error.heldBy,
                acquired_at: error.acquiredAt,
                age_ms: error.ageMs,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          console.error("hourly-run: cycle failed", error);
          return new Response(
            JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

      },
    },
  },
});
