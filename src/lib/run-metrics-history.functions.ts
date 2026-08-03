import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { InputSchema } from "./run-metrics-history.helpers";
import type { RunMetricRow } from "./run-metrics-history.helpers";
export type { RunMetricRow };

export const listRunMetrics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => InputSchema.parse(v ?? {}))
  .handler(async ({ data, context }): Promise<RunMetricRow[]> => {
    const sinceIso = new Date(Date.now() - data.hours * 3600_000).toISOString();
    const { data: rows, error } = await context.supabase
      .from("run_metrics")
      .select(
        "id, created_at, triggered_by, success, error, duration_ms, portfolios_total, portfolios_ok, portfolios_error, budget_exceeded_count, saxo_calls_total, saxo_calls_ok, saxo_calls_error, saxo_retries_429, news_headlines, prices_refreshed, price_errors",
      )
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return (rows ?? []) as RunMetricRow[];
  });
