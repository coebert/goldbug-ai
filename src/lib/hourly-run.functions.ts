// Manually trigger the full hourly cycle (news refresh, regime detection,
// price refresh, per-portfolio tick + routing). This mirrors the pg_cron
// call to /api/public/hooks/hourly-run.
//
// The hourly cycle can take significantly longer than a Cloudflare Worker
// request's wall-time budget (news + market-data refresh + per-portfolio
// AI ticks can easily exceed 30s when upstream sources are slow, e.g.
// Yahoo 404s / GDELT timeouts). Running it inline inside the server-fn
// request caused the response to be dropped mid-flight (status "0") and
// left a stale lock in `run_locks`, blocking subsequent clicks.
//
// Fix: pre-check the lock synchronously so we can still surface
// RunInProgressError to the UI, then fire-and-forget the actual cycle
// via `ctx.waitUntil` (stashed on globalThis by src/server.ts). The
// admin dashboard polls health every 60s so results appear shortly.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type MinimalResult = {
  ok: true;
  started: true;
  duration_ms: number;
  hour_utc: null;
  date: null;
  news_headlines: null;
  prices_refreshed: null;
  symbols_watched: null;
  portfolios: null;
  skipped_paused: null;
  results: [];
};

export const triggerHourlyRunNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { force?: boolean } | undefined) => ({ force: data?.force === true }))
  .handler(async ({ data }): Promise<MinimalResult> => {
    const started = Date.now();
    const { runHourlyCycle, RunInProgressError } = await import("@/lib/hourly-run.server");

    // Fast pre-check so "already running" surfaces synchronously to the UI
    // rather than getting lost in the background task.
    if (!data.force) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: existing } = await supabaseAdmin
        .from("run_locks")
        .select("owner, acquired_at")
        .eq("name", "hourly-run")
        .maybeSingle();
      if (existing) {
        const ageMs = Date.now() - new Date(existing.acquired_at as string).getTime();
        // Match the runHourlyCycle staleness threshold (3 min).
        if (ageMs < 3 * 60 * 1000) {
          const err = new Error(
            `An hourly run is already in progress (started by ${existing.owner ?? "unknown"} ${Math.round(ageMs / 1000)}s ago). Use "Force clear lock & run" if it is stuck.`,
          ) as Error & { code?: string; heldBy?: string | null; ageMs?: number | null };
          err.code = "run_in_progress";
          err.heldBy = (existing.owner as string | null) ?? null;
          err.ageMs = ageMs;
          throw err;
        }
      }
    }

    // Fire-and-forget: kick the cycle off in the background so the request
    // returns immediately and the client never sees a dropped response.
    const promise = runHourlyCycle({ triggeredBy: "manual", force: data.force })
      .then(() => {
        console.log("[hourly-run] manual background cycle finished");
      })
      .catch((error) => {
        if (error instanceof RunInProgressError) {
          console.warn("[hourly-run] manual background cycle skipped:", error.message);
        } else {
          console.error("[hourly-run] manual background cycle failed:", error);
        }
      });

    const ctx = (globalThis as unknown as { __cfCtx?: { waitUntil?: (p: Promise<unknown>) => void } }).__cfCtx;
    try {
      ctx?.waitUntil?.(promise);
    } catch {
      // If waitUntil is unavailable (e.g. dev/Node runtime), the promise
      // continues on the local event loop; nothing else to do.
    }

    return {
      ok: true,
      started: true,
      duration_ms: Date.now() - started,
      hour_utc: null,
      date: null,
      news_headlines: null,
      prices_refreshed: null,
      symbols_watched: null,
      portfolios: null,
      skipped_paused: null,
      results: [],
    };
  });
