import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type RunMetricRow = {
  id: string;
  created_at: string;
  triggered_by: string;
  success: boolean;
  error: string | null;
  duration_ms: number;
  portfolios_total: number;
  portfolios_ok: number;
  portfolios_error: number;
  budget_exceeded_count: number;
  saxo_calls_total: number;
  saxo_calls_ok: number;
  saxo_calls_error: number;
  saxo_retries_429: number;
  news_headlines: number;
  prices_refreshed: number;
  price_errors: number;
};

const InputSchema = z
  .object({ hours: z.number().int().min(1).max(24 * 30).default(72) })
  .default({ hours: 72 });

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
