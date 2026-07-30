import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Hourly equity points for one portfolio. RLS scopes rows to the owner, so no
 * extra ownership check is needed beyond the authenticated client.
 */
export const getIntradayEquity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        days: z.number().int().min(1).max(120).default(30),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const since = new Date(Date.now() - data.days * 24 * 60 * 60 * 1000).toISOString();
    const { data: rows, error } = await context.supabase
      .from("equity_intraday")
      .select("bucket_hour, cash, holdings_value, total_value")
      .eq("portfolio_id", data.portfolio_id)
      .gte("bucket_hour", since)
      .order("bucket_hour", { ascending: true });
    if (error) throw new Error(error.message);
    return {
      points: (rows ?? []).map((r) => ({
        at: String(r.bucket_hour),
        total_value: Number(r.total_value),
      })),
    };
  });
