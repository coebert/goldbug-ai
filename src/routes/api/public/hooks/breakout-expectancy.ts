// Cron-triggered refresh of the breakout expectancy table.
//
// Weekly job: re-runs the breakout backtest over the latest rolling windows,
// pools them, sanity-gates the candidate and publishes it so the live regime
// gate stops trading on stale evidence. A rejected candidate leaves the
// previous table in force — the run is still recorded for audit.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/breakout-expectancy")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyCronRequest } = await import("@/lib/_server/cron");
        const verified = await verifyCronRequest(request, {
          bucket: "hooks:breakout-expectancy",
          capacity: 4,
          refillPerSec: 4 / 86400,
        });
        if (!verified.ok) return verified.response;

        let dryRun = false;
        let triggeredBy = "cron";
        try {
          const text = await request.clone().text();
          if (text) {
            const parsed = JSON.parse(text) as { dry_run?: boolean; triggered_by?: string };
            dryRun = parsed?.dry_run === true;
            if (typeof parsed?.triggered_by === "string") triggeredBy = parsed.triggered_by.slice(0, 40);
          }
        } catch {
          /* body optional */
        }

        const { acquireRunLock, releaseRunLock } = await import("@/lib/run-lock.server");
        const lock = await acquireRunLock("breakout-expectancy", {
          owner: triggeredBy,
          ttlMs: 10 * 60_000,
        });
        if (!lock.acquired) {
          return new Response(
            JSON.stringify({ error: "run_in_progress", held_by: lock.heldBy, age_ms: lock.ageMs }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        }

        try {
          const { refreshBreakoutExpectancy } = await import(
            "@/lib/breakout-expectancy-refresh.server"
          );
          const result = await refreshBreakoutExpectancy({ dryRun, triggeredBy });
          return Response.json({ ok: true, ...result });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error("breakout-expectancy refresh failed", message);
          return new Response(JSON.stringify({ ok: false, error: message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        } finally {
          await releaseRunLock("breakout-expectancy", triggeredBy);
        }
      },
    },
  },
});
