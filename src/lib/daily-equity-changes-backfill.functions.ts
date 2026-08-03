import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  backfillPortfolioDailyChanges,
  type BackfillResult,
} from "./daily-equity-changes-backfill.server";

import { inputSchema } from "./daily-equity-changes-backfill.helpers";

export const backfillDailyEquityChanges = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => inputSchema.parse(i ?? {}))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const q = supabase
      .from("portfolios")
      .select("id, mode")
      .eq("user_id", userId);
    const { data: portfolios, error } = data.portfolioId
      ? await q.eq("id", data.portfolioId)
      : await q;
    if (error) throw error;

    const results: BackfillResult[] = [];
    for (const p of portfolios ?? []) {
      try {
        results.push(
          await backfillPortfolioDailyChanges(
            supabase,
            { id: p.id as string, mode: (p as { mode?: string }).mode ?? null },
            data.days,
          ),
        );
      } catch (err) {
        results.push({
          portfolioId: p.id as string,
          snapshots: 0,
          rowsWritten: 0,
          fromDate: null,
          toDate: null,
          skipped: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return {
      portfoliosProcessed: results.length,
      totalRowsWritten: results.reduce((a, r) => a + r.rowsWritten, 0),
      days: data.days,
      results,
    };
  });

export const listStoredDailyEquityChanges = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        days: z.number().int().min(1).max(3650).default(365),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: portfolio } = await supabase
      .from("portfolios")
      .select("id")
      .eq("id", data.portfolioId)
      .eq("user_id", userId)
      .single();
    if (!portfolio) throw new Error("Portfolio not found");

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - data.days);
    const sinceIso = since.toISOString().slice(0, 10);

    const { data: rows, error } = await supabase
      .from("daily_equity_changes")
      .select(
        "change_date, prev_date, prev_equity, equity, raw_delta, net_flow, pnl, pct, computed_at",
      )
      .eq("portfolio_id", data.portfolioId)
      .gte("change_date", sinceIso)
      .order("change_date", { ascending: true });
    if (error) throw error;
    return { rows: rows ?? [] };
  });
