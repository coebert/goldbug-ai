import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  analyzePreflight,
  type PreflightAnomalyReport,
  type PhaseSample,
} from "@/lib/preflight-anomaly";
import type { PhaseTiming, RunPhase } from "@/lib/run-telemetry";

const InputSchema = z
  .object({ historyRuns: z.number().int().min(3).max(200).default(30) })
  .default({ historyRuns: 30 });

const PHASES: RunPhase[] = ["saxo_refresh", "news", "regime", "symbols", "prices", "ticks"];

function parsePhases(raw: unknown): PhaseTiming[] {
  if (!Array.isArray(raw)) return [];
  const out: PhaseTiming[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const phase = o.phase as RunPhase;
    if (!PHASES.includes(phase)) continue;
    const ms = Number(o.ms);
    if (!Number.isFinite(ms)) continue;
    out.push({
      phase,
      ms,
      skipped: o.skipped === true,
      note: typeof o.note === "string" ? o.note : undefined,
    });
  }
  return out;
}

export type PreflightAnomalyResponse = {
  report: PreflightAnomalyReport | null;
  latestRunAt: string | null;
  latestTriggeredBy: string | null;
  /** No run has recorded phase timings yet. */
  noData: boolean;
};

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
