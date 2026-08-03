import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  backfillPortfolioIntradayEquity,
  type IntradayBackfillResult,
} from "./equity-intraday-backfill.server";

import { inputSchema } from "./equity-intraday-backfill.helpers";

/**
 * Seed `equity_intraday` from existing daily snapshots so the Hourly view has
 * history from before hourly recording existed. Safe to run repeatedly: rows
 * already present are left untouched.
 */
export const backfillIntradayEquity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => inputSchema.parse(i ?? {}))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const q = supabase.from("portfolios").select("id").eq("user_id", userId);
    const { data: portfolios, error } = data.portfolioId
      ? await q.eq("id", data.portfolioId)
      : await q;
    if (error) throw error;

    const results: IntradayBackfillResult[] = [];
    for (const p of portfolios ?? []) {
      const id = p.id as string;
      try {
        results.push(await backfillPortfolioIntradayEquity(supabase, id, data.days));
      } catch (err) {
        results.push({
          portfolioId: id,
          snapshots: 0,
          rowsWritten: 0,
          fromBucket: null,
          toBucket: null,
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
