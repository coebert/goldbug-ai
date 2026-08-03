// Manually trigger the full hourly cycle (news refresh, regime detection,
// price refresh, per-portfolio tick + routing). This mirrors the pg_cron
// call to /api/public/hooks/hourly-run.
//
// Runs inline with a hard short budget. Fire-and-forget background runs were
// observed getting dropped by the worker lifecycle, leaving stale run_locks.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAal2 } from "@/lib/_server/require-aal2";

type ManualRunResult = {
  ok: true;
  started: false;
  duration_ms: number;
  hour_utc: string;
  date: string;
  news_headlines: number;
  prices_refreshed: number;
  symbols_watched: number;
  portfolios: number;
  skipped_paused: number;
  results: Array<{ id: string; mode: string; ok: boolean; error?: string; skipped?: string; value?: number }>;
};

export const triggerHourlyRunNow = createServerFn({ method: "POST" })
  .middleware([requireAal2])
  .inputValidator((data: { force?: boolean } | undefined) => ({ force: data?.force === true }))
  .handler(async ({ data }): Promise<ManualRunResult> => {
    const started = Date.now();
    const { runHourlyCycle } = await import("@/lib/hourly-run.server");

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
        // Match the runHourlyCycle staleness threshold (90s).
        if (ageMs < 90 * 1000) {
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

    const result = await runHourlyCycle({
      triggeredBy: "manual",
      force: data.force,
      timeBudgetMs: 55_000,
      skipNewsInTicks: true,
    });

    return {
      ok: true,
      started: false,
      duration_ms: Date.now() - started,
      hour_utc: result.hour_utc,
      date: result.date,
      news_headlines: result.news_headlines,
      prices_refreshed: result.prices_refreshed,
      symbols_watched: result.symbols_watched,
      portfolios: result.portfolios,
      skipped_paused: result.skipped_paused,
      results: result.results,
    };
  });
