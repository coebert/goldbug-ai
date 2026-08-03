// Runtime helpers extracted from run-metrics-history.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

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

export const InputSchema = z
  .object({ hours: z.number().int().min(1).max(24 * 30).default(72) })
  .default({ hours: 72 });
