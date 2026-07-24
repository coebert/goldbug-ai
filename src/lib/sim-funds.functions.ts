// Sim-funds server functions (top-up + history).
// Extracted from trading.functions.ts (Phase 3 module decoupling).

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { addSimFundsHandler } from "./sim-funds.server";

export const addSimFunds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        amount: z.number().positive("Amount must be greater than 0").max(1_000_000, "Max 1,000,000 per top-up"),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    return addSimFundsHandler(
      data,
      context.supabase as unknown as Parameters<typeof addSimFundsHandler>[1],
      context.userId,
    );
  });

export const listSimFundEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("sim_fund_events")
      .select("id, amount, currency, balance_after, created_at")
      .eq("portfolio_id", data.id)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return { events: rows ?? [] };
  });
