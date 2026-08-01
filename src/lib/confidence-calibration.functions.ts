import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { CalibrationReport } from "@/lib/confidence-calibration";

export type ConfidenceCalibrationResult = {
  report: CalibrationReport;
  samples: Array<{ conviction: number; hit: boolean; forwardReturn?: number }>;
};

export const getConfidenceCalibration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        horizonDays: z.number().int().min(1).max(30).default(5),
        lookbackDays: z.number().int().min(30).max(1825).default(365),
      })
      .parse(i),
  )
  .handler(async ({ data, context }): Promise<ConfidenceCalibrationResult> => {
    const { buildCalibration } = await import("@/lib/confidence-calibration");
    const { buildCalibrationSamples, calibrationSymbolKeys } = await import(
      "@/lib/confidence-calibration.server"
    );

    const sinceDate = new Date(Date.now() - data.lookbackDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const { data: decisions, error } = await context.supabase
      .from("decisions")
      .select("id, run_date, portfolio_value, raw")
      .eq("portfolio_id", data.portfolioId)
      .gte("run_date", sinceDate)
      .order("run_date", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);

    const rows = (decisions ?? []) as Array<{
      id: string;
      run_date: string;
      portfolio_value: number | string | null;
      raw: unknown;
    }>;

    const symbols = calibrationSymbolKeys(rows).slice(0, 200);
    let prices: Array<{ symbol: string; price_date: string; close: number }> = [];
    if (symbols.length) {
      const { data: p } = await context.supabase
        .from("price_cache")
        .select("symbol, price_date, close")
        .in("symbol", symbols)
        .gte("price_date", sinceDate)
        .order("price_date", { ascending: true })
        .limit(20000);
      prices = (p ?? []) as typeof prices;
    }

    const samples = buildCalibrationSamples(rows, prices, data.horizonDays);
    const report = buildCalibration(samples, { horizonDays: data.horizonDays });
    return { report, samples };
  });
