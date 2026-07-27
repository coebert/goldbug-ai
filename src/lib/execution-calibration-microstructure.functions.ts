// Server functions for the per-symbol microstructure calibration workflow.
// Kept in a client-safe wrapper module — the heavy imports (supabaseAdmin,
// market data) are loaded inside the handler bodies.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type CalibrationRow = {
  symbol: string;
  asset_class: string;
  currency: string | null;
  as_of: string;
  sample_days: number;
  adv_shares_20d: number | null;
  adv_notional_20d: number | null;
  adv_notional_60d: number | null;
  realized_vol_daily: number | null;
  atr_pct_14d: number | null;
  spread_pct_est: number | null;
  half_spread_bps_est: number | null;
  vol_widening_coeff_bps_est: number | null;
  impact_coeff_est: number | null;
  max_impact_bps_est: number | null;
  max_half_spread_bps_est: number | null;
  notes: string | null;
  updated_at: string;
};

/** Kick off a fresh calibration for either an explicit symbol list or the
 *  whole universe. Upserts into `public.execution_calibrations`. */
export const runMicrostructureCalibration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        symbols: z.array(z.string().min(1)).max(200).optional(),
        window_days: z.number().int().min(30).max(365).default(120),
      })
      .parse(i),
  )
  .handler(async ({ data }) => {
    const { calibrateAndPersist } = await import("./execution-calibration.server");
    const res = await calibrateAndPersist(data.symbols, {
      lookbackDays: data.window_days,
    });
    return {
      persisted_count: res.persisted.length,
      skipped: res.skipped,
      as_of: res.persisted[0]?.as_of ?? new Date().toISOString().slice(0, 10),
      sample: res.persisted.slice(0, 10).map((r) => ({
        symbol: r.symbol,
        adv_notional_20d: r.adv_notional_20d,
        atr_pct_14d: r.atr_pct_14d,
        impact_coeff: r.tuning.impact_coeff,
        vol_widening_coeff_bps: r.tuning.vol_widening_coeff_bps,
      })),
    };
  });

/** List the currently persisted calibration rows for the UI. */
export const listMicrostructureCalibration = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CalibrationRow[]> => {
    const { data, error } = await context.supabase
      .from("execution_calibrations")
      .select("*")
      .order("adv_notional_20d", { ascending: false, nullsFirst: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []) as CalibrationRow[];
  });
