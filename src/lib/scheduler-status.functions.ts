import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { summariseJobRuns, summariseTickActivity } from "./scheduler-status";
import type { SchedulerJobRunRow } from "./scheduler-status";
import {
  SchedulerStatusInput,
  type SchedulerPortfolioStatus,
  type SchedulerStatusPayload,
} from "./scheduler-status.helpers";

export type { SchedulerStatusPayload, SchedulerPortfolioStatus };

export const getSchedulerStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => SchedulerStatusInput.parse(v ?? {}))
  .handler(async ({ data, context }): Promise<SchedulerStatusPayload> => {
    const sinceIso = new Date(Date.now() - data.days * 86_400_000).toISOString();

    const [{ data: runRows, error: runErr }, { data: pRows, error: pErr }] = await Promise.all([
      context.supabase
        .from("run_metrics")
        .select(
          "id, created_at, triggered_by, success, error, duration_ms, portfolios_total, portfolios_ok, portfolios_error, budget_exceeded_count, phases",
        )
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(1000),
      context.supabase
        .from("portfolios")
        .select("id, name, mode, universe, live_paused, status")
        .eq("status", "active")
        .order("created_at", { ascending: true }),
    ]);
    if (runErr) throw new Error(runErr.message);
    if (pErr) throw new Error(pErr.message);

    const portfolioIds = (pRows ?? []).map((p) => p.id);
    const decisions = portfolioIds.length
      ? await context.supabase
          .from("decisions")
          .select("portfolio_id, created_at")
          .in("portfolio_id", portfolioIds)
          .gte("created_at", sinceIso)
          .order("created_at", { ascending: false })
          .limit(5000)
      : { data: [] as Array<{ portfolio_id: string; created_at: string }>, error: null };
    if (decisions.error) throw new Error(decisions.error.message);

    const byPortfolio = new Map<string, string[]>();
    for (const d of decisions.data ?? []) {
      const list = byPortfolio.get(d.portfolio_id) ?? [];
      list.push(d.created_at);
      byPortfolio.set(d.portfolio_id, list);
    }

    const [{ filterUniverse }, { classesFromUniverse }] = await Promise.all([
      import("./universe.server"),
      import("./trading-engine/candidate-features.server"),
    ]);

    const portfolios: SchedulerPortfolioStatus[] = (pRows ?? []).map((p) => {
      let classes: string[] = [];
      let symbols: string[] = [];
      try {
        const cls = classesFromUniverse(p.universe);
        classes = cls as string[];
        symbols = filterUniverse(cls)
          .slice(0, 22)
          .map((u) => u.symbol);
      } catch {
        classes = [];
        symbols = [];
      }
      return {
        id: p.id,
        name: p.name,
        mode: String(p.mode),
        paused: Boolean(p.live_paused),
        classes,
        symbols,
        activity: summariseTickActivity(byPortfolio.get(p.id) ?? []),
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      windowDays: data.days,
      jobs: summariseJobRuns((runRows ?? []) as unknown as SchedulerJobRunRow[]),
      portfolios,
    };
  });
