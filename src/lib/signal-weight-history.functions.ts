// Loader for the per-signal weight history card.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  buildSignalWeightHistory,
  SIGNAL_WINDOW_MAX,
  SIGNAL_WINDOW_MIN,
  type SignalWeightHistory,
  type SignalWeightRow,
} from "@/lib/signal-weight-history";

export const getSignalWeightHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        windowDays: z.number().int().min(SIGNAL_WINDOW_MIN).max(SIGNAL_WINDOW_MAX).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<SignalWeightHistory> => {
    const { supabase, userId } = context;
    const windowDays = data.windowDays ?? 30;

    const p = await supabase
      .from("portfolios")
      .select("id, user_id")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (p.error || !p.data || p.data.user_id !== userId) throw new Error("Portfolio not found");

    const since = new Date(Date.now() - (windowDays + 5) * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const { data: rows } = await supabase
      .from("signal_weight_history")
      .select("as_of, model_kind, base_weight, multiplier, effective_weight, regime, reason")
      .eq("portfolio_id", data.portfolioId)
      .gte("as_of", since)
      .order("as_of", { ascending: true })
      .limit(1000);

    return buildSignalWeightHistory(
      data.portfolioId,
      (rows ?? []) as unknown as SignalWeightRow[],
      windowDays,
    );
  });
