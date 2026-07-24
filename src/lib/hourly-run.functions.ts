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
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      throw new Error(
        "Manual trigger unavailable: CRON_SECRET is not configured on the server.",
      );
    }
    const { getRequest } = await import("@tanstack/react-start/server");
    const req = getRequest();
    const origin = new URL(req.url).origin;
    const url = `${origin}/api/public/hooks/hourly-run`;
    const started = Date.now();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": secret,
      },
      body: JSON.stringify({ manual: true, triggered_at: new Date().toISOString() }),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const obj = (parsed && typeof parsed === "object") ? (parsed as Record<string, unknown>) : {};
    if (!res.ok) {
      if (res.status === 409) {
        const msg =
          typeof obj.message === "string"
            ? obj.message
            : "An hourly run is already in progress. Please wait for it to finish before triggering another.";
        const err = new Error(msg) as Error & { code?: string; heldBy?: string | null; ageMs?: number | null };
        err.code = "run_in_progress";
        err.heldBy = typeof obj.held_by === "string" ? obj.held_by : null;
        err.ageMs = typeof obj.age_ms === "number" ? obj.age_ms : null;
        throw err;
      }
      const errMsg = typeof obj.error === "string" ? obj.error : `Hourly run failed with status ${res.status}`;
      throw new Error(errMsg);
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
