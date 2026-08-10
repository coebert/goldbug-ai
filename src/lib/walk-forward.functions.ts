// Walk-forward evaluation server function (thin wrapper — see the
// serverFn splitting rules: no runtime helpers at module scope).

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const runWalkForward = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        train_days: z.number().int().min(90).max(2000).default(504),
        test_days: z.number().int().min(30).max(750).default(126),
        mode: z.enum(["rolling", "anchored"]).default("rolling"),
        objective: z.enum(["sharpe", "return", "calmar"]).default("sharpe"),
        max_folds: z.number().int().min(1).max(12).default(8),
        commission_bps: z.number().min(0).max(500).default(5),
        slippage_bps: z.number().min(0).max(500).default(10),
        min_trade_value: z.number().min(0).max(100000).default(25),
        /** Days reserved at the end of history; 0 disables the holdout. */
        holdout_days: z.number().int().min(0).max(1000).default(252),
        holdout_segment_days: z.number().int().min(20).max(500).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: p, error } = await context.supabase
      .from("portfolios")
      .select("id, starting_cash, currency, risk_level, risk_config")
      .eq("id", data.portfolio_id)
      .single();
    if (error || !p) throw new Error("Portfolio not found");

    const { runWalkForwardEvaluation } = await import("./walk-forward.server");
    return runWalkForwardEvaluation({
      from: data.from,
      to: data.to,
      startingCash: Number(p.starting_cash),
      currency: p.currency ?? "GBP",
      riskLevel: p.risk_level ?? "balanced",
      riskConfig: p.risk_config,
      trainDays: data.train_days,
      testDays: data.test_days,
      mode: data.mode,
      maxFolds: data.max_folds,
      objective: data.objective,
      holdoutDays: data.holdout_days,
      ...(data.holdout_segment_days === undefined
        ? {}
        : { holdoutSegmentDays: data.holdout_segment_days }),
      execution: {
        commission_bps: data.commission_bps,
        slippage_bps: data.slippage_bps,
        min_trade_value: data.min_trade_value,
      },
    });
  });
