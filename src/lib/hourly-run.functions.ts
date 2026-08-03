// Manually trigger the full hourly cycle (news refresh, regime detection,
// price refresh, per-portfolio tick + routing). This mirrors the pg_cron
// call to /api/public/hooks/hourly-run.
//
// Runs inline with a hard short budget. Fire-and-forget background runs were
// observed getting dropped by the worker lifecycle, leaving stale run_locks.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAal2 } from "@/lib/_server/require-aal2";
import type { RunPortfolioStatus } from "@/lib/run-portfolio-status";

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
  results: Array<{
    id: string;
    mode: string;
    ok: boolean;
    error?: string;
    skipped?: string;
    value?: number;
    name?: string | null;
    started_at?: string;
    finished_at?: string;
    duration_ms?: number;
  }>;
  /** Status + last-run timestamp for every portfolio, selected or not. */
  portfolio_status: RunPortfolioStatus[];
  /** Deadline / pre-flight / selection diagnostics for this run. */
  telemetry: {
    run_id: string;
    budget_ms: number;
    duration_ms: number;
    deadline_exceeded: boolean;
    overrun_ms: number;
    preflight_ms: number;
    preflight_budget_pct: number;
    preflight_refresh: boolean;
    phases: Array<{ phase: string; ms: number; skipped: boolean; note?: string }>;
    selection: {
      scoped: boolean;
      requested_count: number;
      matched: string[];
      unknown_ids: string[];
      paused_excluded: string[];
    } | null;
    ticked: string[];
    skipped_budget: string[];
  };
};


export const triggerHourlyRunNow = createServerFn({ method: "POST" })
  .middleware([requireAal2])
  .inputValidator((data: { force?: boolean; forceTick?: boolean; portfolioIds?: string[] } | undefined) => ({
    force: data?.force === true,
    // Override the "already ticked" skip window without clearing the lock.
    forceTick: data?.forceTick === true,
    portfolioIds: Array.isArray(data?.portfolioIds)
      ? data.portfolioIds.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, 50)
      : [],
  }))
  .handler(async ({ data }): Promise<ManualRunResult> => {
    const started = Date.now();
    const { runHourlyCycle } = await import("@/lib/hourly-run.server");

    // Fast pre-check so "already running" surfaces synchronously to the UI
    // rather than getting lost in the background task.
    if (!data.force) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { isExpired } = await import("@/lib/run-lock-ttl");
      const { data: existing } = await supabaseAdmin
        .from("run_locks")
        .select("owner, acquired_at, expires_at")
        .eq("name", "hourly-run")
        .maybeSingle();
      if (existing) {
        const ageMs = Date.now() - new Date(existing.acquired_at as string).getTime();
        // A lock past its TTL is garbage — runHourlyCycle will sweep it, so
        // don't surface a bogus "already running" error to the UI.
        const expired = isExpired(
          {
            acquired_at: existing.acquired_at as string,
            expires_at: (existing as { expires_at?: string | null }).expires_at ?? null,
          },
          Date.now(),
          90 * 1000,
        );
        if (!expired && ageMs < 90 * 1000) {

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
      forceTick: data.forceTick,
      timeBudgetMs: 55_000,
      skipNewsInTicks: true,
      // Manual runs are request-bound. Broad refreshes are already performed
      // by their dedicated schedules and previously consumed most of this
      // request's lifetime before any selected portfolio could run.
      preflightRefresh: false,
      portfolioIds: data.portfolioIds,
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
      portfolio_status: result.portfolio_status,
      telemetry: {
        run_id: result.telemetry.run_id,
        budget_ms: result.telemetry.budget_ms,
        duration_ms: result.telemetry.duration_ms,
        deadline_exceeded: result.telemetry.deadline_exceeded,
        overrun_ms: result.telemetry.overrun_ms,
        preflight_ms: result.telemetry.preflight_ms,
        preflight_budget_pct: result.telemetry.preflight_budget_pct,
        preflight_refresh: result.telemetry.preflight_refresh,
        phases: result.telemetry.phases,
        selection: result.telemetry.selection
          ? {
              scoped: result.telemetry.selection.scoped,
              requested_count: result.telemetry.selection.requested_count,
              matched: result.telemetry.selection.matched,
              unknown_ids: result.telemetry.selection.unknown_ids,
              paused_excluded: result.telemetry.selection.paused_excluded,
            }
          : null,
        ticked: result.telemetry.ticked,
        skipped_budget: result.telemetry.skipped_budget,
      },

    };
  });
