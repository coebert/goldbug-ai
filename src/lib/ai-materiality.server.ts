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

import { createHash } from "node:crypto";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  assessDecisionMateriality,
  type MaterialityDecision,
  type MaterialityInputs,
} from "./ai-materiality";

type PriorDecision = {
  fingerprint: string | null;
  decidedAt: string | null;
  newsDigest: string | null;
};

/** Stable digest of the headlines actually shown to the model this tick. */
export function newsDigestOf(headlines: readonly string[]): string {
  return createHash("sha256")
    .update([...headlines].sort().join("\u0000"))
    .digest("hex")
    .slice(0, 32);
}

async function loadPriorDecision(portfolioId: string): Promise<PriorDecision> {
  try {
    const { data } = await supabaseAdmin
      .from("decisions")
      .select("created_at, raw")
      .eq("portfolio_id", portfolioId)
      .order("created_at", { ascending: false })
      .limit(1);
    const row = data?.[0] as { created_at?: string | null; raw?: unknown } | undefined;
    if (!row) return { fingerprint: null, decidedAt: null, newsDigest: null };
    const raw = (row.raw ?? {}) as Record<string, unknown>;
    const materiality = (raw["materiality"] ?? {}) as Record<string, unknown>;
    const fp = materiality["fingerprint"];
    const at = materiality["last_ai_call_at"];
    const digest = materiality["news_digest"];
    return {
      fingerprint: typeof fp === "string" && fp.length > 0 ? fp : null,
      decidedAt: typeof at === "string" ? at : (row.created_at ?? null),
      newsDigest: typeof digest === "string" && digest.length > 0 ? digest : null,
    };
  } catch {
    return { fingerprint: null, decidedAt: null, newsDigest: null };
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
  inputs: Omit<MaterialityInputs, "freshNewsCount">;
  /** Headlines that would be sent to the model this tick. */
  headlines: readonly string[];
  force?: boolean;
  now?: Date;
}): Promise<MaterialityDecision & { previousCallAt: string | null; newsDigest: string }> {
  const newsDigest = newsDigestOf(args.headlines);
  if (args.force) {
    return {
      callAi: true,
      fingerprint: assessDecisionMateriality({
        inputs: { ...args.inputs, freshNewsCount: 0 },
        previousFingerprint: null,
        previousCallAt: null,
        now: args.now,
      }).fingerprint,
      reason: "forced run",
      previousCallAt: null,
      newsDigest,
    };
  }
  const prior = await loadPriorDecision(args.portfolioId);
  const assessed = assessDecisionMateriality({
    inputs: {
      ...args.inputs,
      // Only genuinely new headlines count as news; an unchanged reel is not
      // a reason to buy another opinion.
      freshNewsCount: prior.newsDigest && prior.newsDigest === newsDigest ? 0 : 1,
    },
    previousFingerprint: prior.fingerprint,
    previousCallAt: prior.decidedAt,
    now: args.now,
  });
  return { ...assessed, previousCallAt: prior.decidedAt, newsDigest };
}
