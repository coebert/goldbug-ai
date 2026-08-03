// Runtime helpers extracted from algo-regime-scheduled-autotune.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  calibrateRegime,
  type CalibrationReport,
  type EquityPoint,
  type RegimeObservation,
} from "@/lib/microstructure/algo-regime-calibration";
import { suggestConfigAdjustments, type RiskLevel } from "@/lib/microstructure/algo-regime-autotune";
import {
  evaluateShadow,
  DEFAULT_SHADOW_EVAL_OPTIONS,
} from "@/lib/microstructure/algo-regime-shadow-eval";
import {
  DEFAULT_ALGO_REGIME_CONFIG,
  type AlgoRegimeConfig,
  type AlgoRegimeSnapshot,
} from "@/lib/microstructure/algo-regime";

/** Default shadow window before we're willing to evaluate a pending tune. */
export const DEFAULT_SHADOW_WINDOW_DAYS = 7;

// ---------- shared helpers -------------------------------------------------

export async function loadObservationsAndEquity(
  supabase: { from: (t: string) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  portfolioId: string,
  sinceDate?: string,
) {
  let decQ = supabase
    .from("decisions")
    .select("run_date, raw")
    .eq("portfolio_id", portfolioId)
    .order("run_date", { ascending: true })
    .limit(400);
  if (sinceDate) decQ = decQ.gte("run_date", sinceDate);
  const { data: decisions, error: decErr } = await decQ;
  if (decErr) throw new Error(decErr.message);

  const observations: RegimeObservation[] = [];
  for (const d of decisions ?? []) {
    const raw = d.raw as Record<string, unknown> | null;
    const snap = raw?.algo_regime as AlgoRegimeSnapshot | null | undefined;
    if (!snap || typeof snap.tier !== "string") continue;
    observations.push({ date: d.run_date as string, tier: snap.tier });
  }

  let eqQ = supabase
    .from("equity_snapshots")
    .select("snapshot_date, total_value")
    .eq("portfolio_id", portfolioId)
    .order("snapshot_date", { ascending: true });
  if (sinceDate) eqQ = eqQ.gte("snapshot_date", sinceDate);
  const { data: eqRows, error: eqErr } = await eqQ;
  if (eqErr) throw new Error(eqErr.message);
  const equity: EquityPoint[] = (eqRows ?? []).map((r: {
    snapshot_date: string; total_value: number | string;
  }) => ({ date: r.snapshot_date, totalValue: Number(r.total_value) }));

  return { observations, equity };
}

export async function loadOverride(
  supabase: { from: (t: string) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  portfolioId: string,
): Promise<AlgoRegimeConfig> {
  const { data } = await supabase
    .from("algo_regime_config_overrides")
    .select("config")
    .eq("portfolio_id", portfolioId)
    .maybeSingle();
  return {
    ...DEFAULT_ALGO_REGIME_CONFIG,
    ...((data?.config as Partial<AlgoRegimeConfig> | undefined) ?? {}),
  };
}

export async function loadRiskLevel(
  supabase: { from: (t: string) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  portfolioId: string,
): Promise<RiskLevel> {
  const { data } = await supabase
    .from("portfolios")
    .select("risk_level")
    .eq("id", portfolioId)
    .maybeSingle();
  const r = (data?.risk_level as string | undefined) ?? "balanced";
  return r === "conservative" || r === "aggressive" ? r : "balanced";
}

export async function persistOverride(
  supabase: { from: (t: string) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  portfolioId: string,
  config: AlgoRegimeConfig,
  notes: string,
) {
  const { error } = await supabase
    .from("algo_regime_config_overrides")
    .upsert(
      {
        portfolio_id: portfolioId,
        config,
        tuned_at: new Date().toISOString(),
        notes,
      },
      { onConflict: "portfolio_id" },
    );
  if (error) throw new Error(error.message);
}

export function tierMean(r: CalibrationReport, tier: "normal" | "extreme"): number | null {
  const row = r.perTier.find((t) => t.tier === tier);
  return row && row.count > 0 ? row.meanReturn : null;
}

// ---------- 1. apply with shadow ------------------------------------------

export type ApplyTuneResponse = {
  changed: boolean;
  persisted: boolean;
  historyId: string | null;
  previous: AlgoRegimeConfig;
  suggested: AlgoRegimeConfig;
  notes: string[];
  baseline: {
    matched: number;
    monotone: boolean;
    normalMean: number | null;
    extremeMean: number | null;
  };
};

// ---------- 2. evaluate the shadow window ---------------------------------

export type ShadowEvaluationRowResult = {
  historyId: string;
  action: "keep" | "rollback" | "wait";
  reason: string;
  postMatched: number;
  postMonotone: boolean;
};

export type EvaluateShadowResponse = {
  processed: number;
  results: ShadowEvaluationRowResult[];
};

// ---------- 3. manual rollback --------------------------------------------

export type ManualRollbackResponse = { restored: AlgoRegimeConfig };

// ---------- 4. history listing --------------------------------------------

export type TuneHistoryRow = {
  id: string;
  appliedAt: string;
  evaluatedAt: string | null;
  status: "pending" | "accepted" | "rolled_back" | "superseded";
  decisionReason: string | null;
  notes: string | null;
  baseline: { matched: number; monotone: boolean };
  post: { matched: number | null; monotone: boolean | null };
};
