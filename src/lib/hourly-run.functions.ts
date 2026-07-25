// Manually trigger the full hourly cycle (news refresh, regime detection,
// price refresh, per-portfolio tick + routing). This mirrors the pg_cron
// call to /api/public/hooks/hourly-run by POSTing to that same endpoint
// with the server-side CRON_SECRET so all shared logic stays in one place.
//
// Split out of trading.functions.ts during Phase 3. Re-exported from the
// legacy "@/lib/trading.functions" barrel for backwards compatibility.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const triggerHourlyRunNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const started = Date.now();
    const { runHourlyCycle, RunInProgressError } = await import("@/lib/hourly-run.server");
    let obj: Record<string, unknown>;
    try {
      obj = await runHourlyCycle({ triggeredBy: "manual" }) as unknown as Record<string, unknown>;
    } catch (error) {
      if (error instanceof RunInProgressError) {
        const err = new Error(error.message) as Error & { code?: string; heldBy?: string | null; ageMs?: number | null };
        err.code = "run_in_progress";
        err.heldBy = error.heldBy;
        err.ageMs = error.ageMs;
        throw err;
      }
      throw error;
    }
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const arr = Array.isArray(obj.results) ? obj.results as Array<Record<string, unknown>> : [];
    const results = arr.map((r) => ({
      id: str(r.id) ?? "",
      mode: str(r.mode) ?? "",
      ok: r.ok === true,
      value: num(r.value),
      skipped: str(r.skipped),
      error: str(r.error),
    }));
    return {
      ok: true,
      duration_ms: Date.now() - started,
      hour_utc: str(obj.hour_utc),
      date: str(obj.date),
      news_headlines: num(obj.news_headlines),
      prices_refreshed: num(obj.prices_refreshed),
      symbols_watched: num(obj.symbols_watched),
      portfolios: num(obj.portfolios),
      skipped_paused: num(obj.skipped_paused),
      results,
    };
  });
