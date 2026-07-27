// Phase G — Calibration server function. Joins persisted algo-regime
// snapshots (decisions.raw.algo_regime) with the portfolio's equity
// snapshots and returns realised per-tier forward-return statistics.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  calibrateRegime,
  type CalibrationReport,
  type RegimeObservation,
  type EquityPoint,
} from "@/lib/microstructure/algo-regime-calibration";
import type { AlgoRegimeSnapshot } from "@/lib/microstructure/algo-regime";

export const getAlgoRegimeCalibration = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      portfolioId: z.string().uuid(),
      limit: z.number().int().min(10).max(500).default(200),
    }).parse(i),
  )
  .handler(async ({ data, context }): Promise<CalibrationReport> => {
    const { data: decisions, error: decErr } = await context.supabase
      .from("decisions")
      .select("run_date, raw")
      .eq("portfolio_id", data.portfolioId)
      .order("run_date", { ascending: true })
      .limit(data.limit);
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

    return calibrateRegime(observations, equity);
  });
