// Admin health snapshot: broker ping (SIM + LIVE), OAuth token expiry, last
// successful routed order, recent routing errors, and cron activity.
// All reads scoped to the signed-in user via requireSupabaseAuth.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { envHealth } from "./admin.helpers";
import type { BrokerEnvHealth, RoutingActivity, AdminHealthSnapshot } from "./admin.helpers";
export type { BrokerEnvHealth, RoutingActivity, AdminHealthSnapshot };

export const getAdminHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AdminHealthSnapshot> => {
    const { supabase, userId } = context;

    const [sim, live] = await Promise.all([envHealth(userId, "sim"), envHealth(userId, "live")]);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: logs } = await supabase
      .from("live_broker_log")
      .select("method, path, env, status, error, created_at")
      .eq("user_id", userId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);

    const rows = logs ?? [];
    const isRouting = (r: { method: string }) =>
      r.method === "POST" || r.method === "ROUTE_SKIPPED_PAPER_ONLY";

    const isSuccess = (r: { method: string; status: number | null; error: string | null }) =>
      r.method === "POST" && !r.error && (r.status ?? 0) < 400;
    const isFailure = (r: { method: string; status: number | null; error: string | null }) =>
      r.method === "POST" && (!!r.error || (r.status ?? 0) >= 400);
    const isPaperSkip = (r: { method: string }) => r.method === "ROUTE_SKIPPED_PAPER_ONLY";

    const successes = rows.filter(isSuccess);
    const failures = rows.filter(isFailure);
    const paperSkips = rows.filter(isPaperSkip);

    const routing: RoutingActivity = {
      lastSuccessAt: successes[0]?.created_at ?? null,
      lastSuccessPath: successes[0]?.path ?? null,
      lastSuccessEnv: successes[0]?.env ?? null,
      lastFailureAt: failures[0]?.created_at ?? null,
      lastFailureError: failures[0]?.error ?? null,
      successCount24h: successes.length,
      failureCount24h: failures.length,
      paperSkipCount24h: paperSkips.length,
    };

    // Cron freshness: any log entry within the last 70 min means the hourly
    // cron has fired for this user. (Reconciliation and hourly-run both write.)
    const lastRunAt = rows.find(isRouting)?.created_at ?? rows[0]?.created_at ?? null;
    const ranWithinHour = lastRunAt
      ? Date.now() - new Date(lastRunAt).getTime() < 70 * 60 * 1000
      : false;

    const kill = (process.env.LIVE_SIM_PAPER_ONLY ?? "").toLowerCase();
    const paperOnlyKillSwitch = kill === "true" || kill === "1" || kill === "yes";

    return {
      generatedAt: new Date().toISOString(),
      paperOnlyKillSwitch,
      environments: [sim, live],
      routing,
      cron: { lastRunAt, ranWithinHour },
    };
  });
