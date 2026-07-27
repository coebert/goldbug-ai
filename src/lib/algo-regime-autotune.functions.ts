// Phase G+ — Auto-tune server function. Reads the calibration for a portfolio,
// runs the pure `suggestConfigAdjustments` heuristic, and upserts the new
// AlgoRegimeConfig into `algo_regime_config_overrides`. The trading engine's
// `buildAlgoRegimeSnapshot` picks the override up on the next tick.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  calibrateRegime,
  type EquityPoint,
  type RegimeObservation,
} from "@/lib/microstructure/algo-regime-calibration";
import {
  suggestConfigAdjustments,
  type AutoTuneResult,
} from "@/lib/microstructure/algo-regime-autotune";
import {
  DEFAULT_ALGO_REGIME_CONFIG,
  type AlgoRegimeConfig,
  type AlgoRegimeSnapshot,
} from "@/lib/microstructure/algo-regime";

export type AutoTuneResponse = AutoTuneResult & {
  previous: AlgoRegimeConfig;
  persisted: boolean;
  matched: number;
};

export const autoTuneAlgoRegime = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      portfolioId: z.string().uuid(),
      dryRun: z.boolean().default(false),
    }).parse(i),
  )
  .handler(async ({ data, context }): Promise<AutoTuneResponse> => {
    // 1. Pull the observation history and equity snapshots (same shape the
    //    calibration server fn uses — kept inline so tuning stays independent
    //    of the read endpoint's pagination).
    const { data: decisions, error: decErr } = await context.supabase
      .from("decisions")
      .select("run_date, raw")
      .eq("portfolio_id", data.portfolioId)
      .order("run_date", { ascending: true })
      .limit(400);
    if (decErr) throw new Error(decErr.message);

    const observations: RegimeObservation[] = [];
    for (const d of decisions ?? []) {
      const raw = d.raw as Record<string, unknown> | null;
      const snap = raw?.algo_regime as AlgoRegimeSnapshot | null | undefined;
      if (!snap || typeof snap.tier !== "string") continue;
      observations.push({ date: d.run_date as string, tier: snap.tier });
    }

    const { data: eqRows, error: eqErr } = await context.supabase
      .from("equity_snapshots")
      .select("snapshot_date, total_value")
      .eq("portfolio_id", data.portfolioId)
      .order("snapshot_date", { ascending: true });
    if (eqErr) throw new Error(eqErr.message);
    const equity: EquityPoint[] = (eqRows ?? []).map((r) => ({
      date: r.snapshot_date as string,
      totalValue: Number(r.total_value),
    }));

    const report = calibrateRegime(observations, equity);

    // 2. Load the current override (if any) so we tune INCREMENTALLY rather
    //    than always starting from defaults.
    const { data: existing } = await context.supabase
      .from("algo_regime_config_overrides")
      .select("config")
      .eq("portfolio_id", data.portfolioId)
      .maybeSingle();
    const previous: AlgoRegimeConfig = {
      ...DEFAULT_ALGO_REGIME_CONFIG,
      ...((existing?.config as Partial<AlgoRegimeConfig> | undefined) ?? {}),
    };

    const tuned = suggestConfigAdjustments(report, previous);

    // 3. Persist unless dry-run or nothing changed.
    let persisted = false;
    if (!data.dryRun && tuned.changed) {
      const { error: upErr } = await context.supabase
        .from("algo_regime_config_overrides")
        .upsert(
          {
            portfolio_id: data.portfolioId,
            config: tuned.suggested,
            tuned_at: new Date().toISOString(),
            notes: tuned.notes.join(" | "),
          },
          { onConflict: "portfolio_id" },
        );
      if (upErr) throw new Error(upErr.message);
      persisted = true;
    }

    return { ...tuned, previous, persisted, matched: report.matched };
  });
