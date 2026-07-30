// Server functions exposing Gemini relevance-scoring health to the UI.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { RelevanceFailureReason } from "./news-relevance-telemetry";

export type RelevanceRunRow = {
  id: string;
  created_at: string;
  news_date: string;
  trigger: string;
  items: number;
  batches: number;
  batch_failures: number;
  llm_scored: number;
  fallback_items: number;
  latency_ms_total: number;
  latency_ms_p50: number;
  latency_ms_max: number;
  failure_reasons: Partial<Record<RelevanceFailureReason, number>>;
  fallback_reason: string | null;
};

export const getRelevanceScoringTelemetry = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { limit?: number } | undefined) => ({
    limit: Math.max(1, Math.min(50, Math.round(Number(input?.limit ?? 12)))),
  }))
  .handler(async ({ context, data }): Promise<{ runs: RelevanceRunRow[] }> => {
    const { data: rows, error } = await context.supabase
      .from("news_relevance_runs")
      .select(
        "id, created_at, news_date, trigger, items, batches, batch_failures, llm_scored, fallback_items, latency_ms_total, latency_ms_p50, latency_ms_max, failure_reasons, fallback_reason",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (error) {
      console.warn("relevance telemetry read failed", error.message);
      return { runs: [] };
    }
    return {
      runs: (rows ?? []).map((r) => ({
        ...(r as unknown as RelevanceRunRow),
        failure_reasons: (r.failure_reasons ?? {}) as RelevanceRunRow["failure_reasons"],
      })),
    };
  });
