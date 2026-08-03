// Durable audit log for hedge-instrument fallbacks.
//
// Every time the tail-hedge executor cannot use the primary gold wrapper —
// because the broker blocks it (Saxo ETC suitability), it has no quote, it is
// not in the universe, or there is nothing held to unwind — we persist one row
// describing the blocked primary, the substitute that was chosen (if any) and
// the specific reason the substitution happened. Trade reason strings are
// lossy and get truncated; this table is the reconstructable record.
//
// Fire-and-forget: a failed audit write must never break a trading run.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ukDayKey } from "@/lib/uk-time";
import type { HedgeFallbackAudit } from "./tail-hedge-executor.server";

export type HedgeFallbackAuditRecord = {
  userId: string | null | undefined;
  portfolioId: string;
  currency: string;
  decisionId?: string | null;
  runDate?: string | null;
  /** Whether the hedge leg actually executed after the substitution. */
  applied: boolean;
  /** Notional actually traded (0 when the hedge was skipped). */
  appliedNotional: number;
  audit: HedgeFallbackAudit;
};

export function buildHedgeFallbackRow(input: HedgeFallbackAuditRecord) {
  const { audit } = input;
  return {
    user_id: input.userId as string,
    portfolio_id: input.portfolioId,
    decision_id: input.decisionId ?? null,
    run_date: input.runDate || ukDayKey(new Date()),
    currency: (input.currency || "GBP").toUpperCase(),
    side: audit.side,
    primary_symbol: audit.primarySymbol,
    chosen_symbol: audit.chosenSymbol,
    reason_code: audit.reasonCode,
    reason_detail: audit.reasonDetail.slice(0, 2000),
    candidates: audit.candidates,
    applied: input.applied,
    target_notional: Number.isFinite(audit.targetNotional) ? audit.targetNotional : 0,
    applied_notional: Number.isFinite(input.appliedNotional) ? input.appliedNotional : 0,
  };
}

/** Persist one fallback event. Never throws. */
export function recordHedgeFallbackEvent(input: HedgeFallbackAuditRecord): void {
  if (!input.userId) return;
  void (async () => {
    try {
      const { error } = await (supabaseAdmin as never as {
        from: (t: string) => { insert: (v: unknown) => Promise<{ error: unknown }> };
      })
        .from("hedge_fallback_events")
        .insert(buildHedgeFallbackRow(input));
      if (error) console.error("[hedge-fallback-audit] insert failed", error);
    } catch (e) {
      console.error("[hedge-fallback-audit] unexpected", e);
    }
  })();
}
