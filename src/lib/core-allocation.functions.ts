import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type CoreAllocationControls = {
  targetPct: number;
  symbol: string;
  bandPct: number;
};

export const getCoreAllocation = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CoreAllocationControls> => {
    const { data, error } = await context.supabase
      .from("trading_controls")
      .select("core_allocation_pct, core_symbol, core_band_pct")
      .eq("id", true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      targetPct: Number(data?.core_allocation_pct ?? 0),
      symbol: String(data?.core_symbol ?? "VWRL.L"),
      bandPct: Number(data?.core_band_pct ?? 0.05),
    };
  });

export const saveCoreAllocation = createServerFn({ method: "POST" })
  .inputValidator((data) =>
    z
      .object({
        targetPct: z.number().min(0).max(0.9),
        symbol: z.string().min(1).max(24),
        bandPct: z.number().min(0.01).max(0.3),
      })
      .parse(data),
  )
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("trading_controls")
      .update({
        core_allocation_pct: data.targetPct,
        core_symbol: data.symbol.toUpperCase(),
        core_band_pct: data.bandPct,
      })
      .eq("id", true);
    if (error) throw new Error(error.message);
    return { ok: true as const, ...data };
  });
