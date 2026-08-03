import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  analyzePreflight,
  type PreflightAnomalyReport,
  type PhaseSample,
} from "@/lib/preflight-anomaly";
import type { PhaseTiming, RunPhase } from "@/lib/run-telemetry";

import { InputSchema, PHASES, parsePhases } from "./preflight-anomaly.helpers";
import type { PreflightAnomalyResponse } from "./preflight-anomaly.helpers";
export type { PreflightAnomalyResponse };

/**
 * Analyses the most recent run's pre-flight timings against the previous runs
 * and returns the step to investigate. Read-only.
 */
export const getPreflightAnomaly = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => InputSchema.parse(v ?? {}))
  .handler(async ({ data, context }): Promise<PreflightAnomalyResponse> => {
    const { data: rows, error } = await context.supabase
      .from("run_metrics")
      .select("created_at, triggered_by, budget_ms, phases")
      .not("phases", "is", null)
      .order("created_at", { ascending: false })
      .limit(data.historyRuns + 1);
    if (error) throw new Error(error.message);

    const runs = (rows ?? []) as Array<{
      created_at: string;
      triggered_by: string;
      budget_ms: number | null;
      phases: unknown;
    }>;
    if (runs.length === 0) {
      return { report: null, latestRunAt: null, latestTriggeredBy: null, noData: true };
    }

    const latest = runs[0];
    const history: PhaseSample[][] = runs
      .slice(1)
      .map((r) => parsePhases(r.phases).filter((p) => !p.skipped).map((p) => ({ phase: p.phase, ms: p.ms })));

    const report = analyzePreflight({
      phases: parsePhases(latest.phases),
      history,
      budgetMs: latest.budget_ms ?? 55_000,
    });

    return {
      report,
      latestRunAt: latest.created_at,
      latestTriggeredBy: latest.triggered_by,
      noData: false,
    };
  });
