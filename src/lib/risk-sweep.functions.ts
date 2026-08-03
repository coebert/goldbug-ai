// Server fn for the risk-dial equity-curve comparison.
// Thin wrapper: everything runtime lives in risk-sweep.server.ts.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { RiskSweepResult } from "./risk-sweep.server";

import { InputSchema } from "./risk-sweep.helpers";

export const runRiskSweepFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => InputSchema.parse(d))
  .handler(async ({ data, context }): Promise<RiskSweepResult> => {
    const { data: pf, error } = await context.supabase
      .from("portfolios")
      .select("id, starting_cash, currency, risk_config")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!pf) throw new Error("Portfolio not found");

    const { runRiskLevelSweep } = await import("./risk-sweep.server");
    const { clampDialLevel } = await import("./risk-aggressiveness");

    const to = new Date();
    const from = new Date(to);
    from.setFullYear(from.getFullYear() - data.years);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    const cfg = (pf.risk_config ?? {}) as Record<string, unknown>;
    return runRiskLevelSweep({
      from: iso(from),
      to: iso(to),
      startingCash: Number(pf.starting_cash) || 10_000,
      currency: pf.currency ?? "GBP",
      currentLevel: clampDialLevel(cfg.risk_level),
    });
  });
