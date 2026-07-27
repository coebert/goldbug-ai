// Phase F — Observability. Read-only aggregation of recent AlgoRegimeSnapshots
// persisted at decisions.raw.algo_regime by the trading engine.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { AlgoRegimeSnapshot } from "@/lib/microstructure/algo-regime";

export type AlgoRegimeHistoryRow = {
  decisionId: string;
  runDate: string;
  createdAt: string;
  snapshot: AlgoRegimeSnapshot;
};

export const listAlgoRegimeHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      portfolioId: z.string().uuid(),
      limit: z.number().int().min(1).max(200).default(60),
    }).parse(i),
  )
  .handler(async ({ data, context }): Promise<AlgoRegimeHistoryRow[]> => {
    const { data: rows, error } = await context.supabase
      .from("decisions")
      .select("id, run_date, created_at, raw")
      .eq("portfolio_id", data.portfolioId)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);

    const out: AlgoRegimeHistoryRow[] = [];
    for (const r of rows ?? []) {
      const raw = r.raw as Record<string, unknown> | null;
      const snap = raw?.algo_regime as AlgoRegimeSnapshot | null | undefined;
      if (!snap || typeof snap !== "object") continue;
      if (typeof snap.tier !== "string") continue;
      out.push({
        decisionId: r.id,
        runDate: r.run_date,
        createdAt: r.created_at,
        snapshot: snap,
      });
    }
    return out;
  });
