import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { FillsTradesReconcileResult } from "./fills-trades-reconcile.server";

const Input = z.object({ portfolioId: z.string().uuid() });

export const reconcileFillsToTrades = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => Input.parse(v))
  .handler(async ({ data, context }): Promise<FillsTradesReconcileResult> => {
    // Confirm ownership via RLS-scoped client before hitting the admin path.
    const own = await context.supabase
      .from("portfolios")
      .select("id, mode")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (own.error || !own.data) throw new Error("Portfolio not found or not owned by caller");

    const { reconcileFillsToTradesForPortfolio } = await import(
      "./fills-trades-reconcile.server"
    );
    return reconcileFillsToTradesForPortfolio(data.portfolioId, context.userId);
  });

export type { FillsTradesReconcileResult };
