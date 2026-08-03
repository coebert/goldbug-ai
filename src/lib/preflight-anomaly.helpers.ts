// Runtime helpers extracted from preflight-anomaly.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  analyzePreflight,
  type PreflightAnomalyReport,
  type PhaseSample,
} from "@/lib/preflight-anomaly";
import type { PhaseTiming, RunPhase } from "@/lib/run-telemetry";

export const InputSchema = z
  .object({ historyRuns: z.number().int().min(3).max(200).default(30) })
  .default({ historyRuns: 30 });

export const PHASES: RunPhase[] = ["saxo_refresh", "news", "regime", "symbols", "prices", "ticks"];

export function parsePhases(raw: unknown): PhaseTiming[] {
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
