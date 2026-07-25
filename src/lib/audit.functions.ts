// Server-side pagination for the trade Audit tab.
// Returns a small window of decision rows scoped to the caller's portfolio via
// RLS on the authenticated Supabase client — the audit view can then lazy-load
// additional pages as the user scrolls, so long decision histories don't ship
// as a single monolithic loader payload.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type AuditDecisionRow = {
  id: string;
  run_date: string;
  portfolio_value: number | string | null;
  raw: unknown;
};

export type AuditDecisionPage = {
  rows: AuditDecisionRow[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
};

export const listAuditDecisions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        page: z.number().int().min(0).max(10_000).default(0),
        pageSize: z.number().int().min(1).max(200).default(50),
      })
      .parse(i),
  )
  .handler(async ({ data, context }): Promise<AuditDecisionPage> => {
    const from = data.page * data.pageSize;
    const to = from + data.pageSize - 1;
    const { data: rows, count, error } = await context.supabase
      .from("decisions")
      .select("id, run_date, portfolio_value, raw", { count: "exact" })
      .eq("portfolio_id", data.portfolioId)
      .order("run_date", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to);
    if (error) throw new Error(error.message);
    const total = count ?? 0;
    return {
      rows: (rows ?? []) as AuditDecisionRow[],
      page: data.page,
      pageSize: data.pageSize,
      total,
      hasMore: from + (rows?.length ?? 0) < total,
    };
  });
