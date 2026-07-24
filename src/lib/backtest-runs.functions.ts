import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Json } from "@/integrations/supabase/types";

// Server-side persistence for backtest run history. The card used to
// stash rows in localStorage; that stayed put per-browser and got lost
// when users switched devices, so we mirror the shape here backed by
// the `backtest_runs` table (RLS: user_id = auth.uid()).

export type PersistedBacktestRun = {
  id: string;
  ran_at: string;
  portfolio_id: string;
  risk_level: string | null;
  days: number;
  // metrics and equity are opaque to the server — the card owns their shape.
  metrics: Json;
  equity: Json | null;
};

export const listBacktestRuns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { portfolioId: string }) => input)
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("backtest_runs")
      .select("id, ran_at, portfolio_id, risk_level, days, metrics, equity")
      .eq("portfolio_id", data.portfolioId)
      .order("ran_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return (rows ?? []) as PersistedBacktestRun[];
  });

export const saveBacktestRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      id?: string;
      portfolioId: string;
      riskLevel?: string | null;
      days: number;
      ranAt?: string;
      metrics: unknown;
      equity?: unknown;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    const row = {
      id: data.id,
      user_id: context.userId,
      portfolio_id: data.portfolioId,
      risk_level: data.riskLevel ?? null,
      days: data.days,
      metrics: data.metrics,
      equity: data.equity ?? null,
      ran_at: data.ranAt ?? new Date().toISOString(),
    };
    const { data: inserted, error } = await context.supabase
      .from("backtest_runs")
      .insert(row)
      .select("id, ran_at, portfolio_id, risk_level, days, metrics, equity")
      .single();
    if (error) throw new Error(error.message);
    return inserted as PersistedBacktestRun;
  });

export const deleteBacktestRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("backtest_runs")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const clearBacktestRuns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { portfolioId: string }) => input)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("backtest_runs")
      .delete()
      .eq("portfolio_id", data.portfolioId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
