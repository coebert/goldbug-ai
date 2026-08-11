// Phase 3 item 11 (application half) — load realised model performance,
// turn it into bounded weight multipliers, and persist the resulting
// weight vector so every run's blend is auditable after the fact.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  applyAdaptiveWeights,
  computeModelMultipliers,
  describeAdaptiveWeights,
  type AdaptiveWeightRow,
  type ModelPerformance,
} from "./adaptive-weights";
import { effectiveWeightsForRegime, type StrategyWeights } from "./regime-matrix";
import type { AlphaModelKind } from "./types";

export type AdaptiveWeightsResult = {
  weights: StrategyWeights;
  rows: AdaptiveWeightRow[];
  note: string;
  adapted: boolean;
};

/**
 * Regime prior × realised-performance multiplier, renormalised.
 * Never throws — on any failure we fall back to the static regime prior.
 */
export async function resolveAdaptiveWeights(args: {
  portfolioId: string;
  regime: string | null | undefined;
  asOf: string;
  enabled?: boolean;
}): Promise<AdaptiveWeightsResult> {
  const base = effectiveWeightsForRegime(args.regime);
  if (args.enabled === false) {
    return { weights: base, rows: [], note: "adaptive weights disabled", adapted: false };
  }
  try {
    const { data } = await supabaseAdmin
      .from("alpha_model_performance" as never)
      .select("model_kind, samples, hit_rate, avg_edge_bps")
      .eq("portfolio_id", args.portfolioId)
      .eq("window_days", 30);

    const perf: ModelPerformance[] = ((data ?? []) as unknown as Array<{
      model_kind: AlphaModelKind;
      samples: number | null;
      hit_rate: number | null;
      avg_edge_bps: number | null;
    }>).map((r) => ({
      model_kind: r.model_kind,
      samples: Number(r.samples ?? 0),
      hit_rate: r.hit_rate == null ? null : Number(r.hit_rate),
      avg_edge_bps: r.avg_edge_bps == null ? null : Number(r.avg_edge_bps),
    }));

    if (perf.length === 0) {
      return { weights: base, rows: [], note: "adaptive weights: no measurements yet", adapted: false };
    }

    const mults = computeModelMultipliers(perf);
    const { weights, rows } = applyAdaptiveWeights(base, mults);
    const note = describeAdaptiveWeights(rows);
    const adapted = rows.some((r) => Math.abs(r.multiplier - 1) > 0.02);

    // Best-effort audit trail; never blocks the run.
    void supabaseAdmin
      .from("signal_weight_history" as never)
      .upsert(
        rows.map((r) => ({
          portfolio_id: args.portfolioId,
          as_of: args.asOf,
          regime: String(args.regime ?? "unknown"),
          model_kind: r.model_kind,
          base_weight: r.base_weight,
          multiplier: r.multiplier,
          effective_weight: r.effective_weight,
          reason: r.reason,
        })) as never,
        { onConflict: "portfolio_id,as_of,model_kind" } as never,
      )
      .then(undefined, () => undefined);

    return { weights, rows, note, adapted };
  } catch {
    return { weights: base, rows: [], note: "adaptive weights unavailable — using regime prior", adapted: false };
  }
}
