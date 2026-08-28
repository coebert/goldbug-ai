// Server-side glue for the pure materiality gate in `ai-materiality.ts`.
//
// The hourly tick calls the decision LLM once per portfolio per hour whether or
// not anything actually moved. Most quiet ticks re-send an almost identical
// picture and get "hold" back. This helper loads the fingerprint stored on the
// previous decision row and answers "is a fresh AI opinion worth paying for?".
//
// Skipping only skips the LLM. Every deterministic guardrail (stops, trailing
// exits, thesis-break exits, reconciliation) still runs on the empty order set,
// exactly like the circuit-breaker and closed-venue branches.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  assessDecisionMateriality,
  type MaterialityDecision,
  type MaterialityInputs,
} from "./ai-materiality";

type PriorDecision = { fingerprint: string | null; decidedAt: string | null };

async function loadPriorDecision(portfolioId: string): Promise<PriorDecision> {
  try {
    const { data } = await supabaseAdmin
      .from("decisions")
      .select("created_at, raw")
      .eq("portfolio_id", portfolioId)
      .order("created_at", { ascending: false })
      .limit(1);
    const row = data?.[0] as { created_at?: string | null; raw?: unknown } | undefined;
    if (!row) return { fingerprint: null, decidedAt: null };
    const raw = (row.raw ?? {}) as Record<string, unknown>;
    const materiality = (raw["materiality"] ?? {}) as Record<string, unknown>;
    const fp = materiality["fingerprint"];
    const at = materiality["last_ai_call_at"];
    return {
      fingerprint: typeof fp === "string" && fp.length > 0 ? fp : null,
      decidedAt: typeof at === "string" ? at : (row.created_at ?? null),
    };
  } catch {
    return { fingerprint: null, decidedAt: null };
  }
}

/**
 * Decide whether this tick should pay for a fresh LLM decision.
 *
 * `force` short-circuits the gate (manual runs, backtests, first tick of a
 * portfolio) so a user-triggered run always gets a real opinion.
 */
export async function shouldCallDecisionAi(args: {
  portfolioId: string;
  inputs: MaterialityInputs;
  force?: boolean;
  now?: Date;
}): Promise<MaterialityDecision & { previousCallAt: string | null }> {
  if (args.force) {
    const assessed = assessDecisionMateriality({
      inputs: args.inputs,
      previousFingerprint: null,
      previousCallAt: null,
      now: args.now,
    });
    return { ...assessed, callAi: true, reason: "forced run", previousCallAt: null };
  }
  const prior = await loadPriorDecision(args.portfolioId);
  const assessed = assessDecisionMateriality({
    inputs: args.inputs,
    previousFingerprint: prior.fingerprint,
    previousCallAt: prior.decidedAt,
    now: args.now,
  });
  return { ...assessed, previousCallAt: prior.decidedAt };
}
