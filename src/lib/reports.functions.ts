// Performance report + cross-portfolio comparison server functions.
// Extracted from trading.functions.ts (Phase 3 module decoupling).

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  addDaysISO,
  computeMetrics,
  isoWeekStart,
  metricsFromValues,
  type PerfBucket,
} from "./reports.server";

export const getPerformanceReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      portfolio_id: z.string().uuid(),
      benchmark: z.string().min(1).max(12).default("SPY"),
      window_days: z.number().int().min(14).max(3650).default(180),
    }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: portfolio, error: pErr } = await context.supabase
      .from("portfolios")
      .select("id,name,currency,starting_cash,risk_level")
      .eq("id", data.portfolio_id)
      .single();
    if (pErr || !portfolio) throw new Error(pErr?.message ?? "Portfolio not found");

    const { data: equity } = await context.supabase
      .from("equity_snapshots")
      .select("snapshot_date,total_value")
      .eq("portfolio_id", data.portfolio_id)
      .order("snapshot_date", { ascending: true });

    const fullSeries = (equity ?? []).map((e) => ({
      date: e.snapshot_date as string,
      value: Number(e.total_value),
    }));
    if (fullSeries.length < 2) {
      return {
        portfolio: {
          id: portfolio.id, name: portfolio.name, currency: portfolio.currency,
          risk_level: portfolio.risk_level, starting_cash: Number(portfolio.starting_cash),
        },
        benchmark: data.benchmark,
        window_days: data.window_days,
        overall: null,
        benchmarkOverall: null,
        strategy_series: [] as Array<{ date: string; strategy: number; benchmark: number | null }>,
        daily: [] as PerfBucket[],
        weekly: [] as PerfBucket[],
        empty: true,
      };
    }

    const asOf = fullSeries[fullSeries.length - 1].date;
    const from = addDaysISO(asOf, -data.window_days);
    const windowed = fullSeries.filter((r) => r.date >= from);
    if (windowed.length < 2) windowed.push(...fullSeries.slice(-2));

    const { getDailyCandlesRange } = await import("./market-data.server");
    let benchCandles: Array<{ date: string; close: number }> = [];
    try {
      const raw = await getDailyCandlesRange(data.benchmark, windowed[0].date, asOf);
      benchCandles = raw.map((c) => ({ date: c.date, close: Number(c.close) }));
    } catch {
      benchCandles = [];
    }
    const benchByDate = new Map(benchCandles.map((c) => [c.date, c.close]));
    const startVal = windowed[0].value;
    const benchStart = benchCandles[0]?.close ?? null;

    let lastClose: number | null = benchStart;
    const strategySeries = windowed.map((r) => {
      const c = benchByDate.get(r.date);
      if (c != null) lastClose = c;
      const benchmark =
        benchStart != null && lastClose != null
          ? Number(((lastClose / benchStart) * startVal).toFixed(4))
          : null;
      return { date: r.date, strategy: r.value, benchmark };
    });

    const stratValues = strategySeries.map((r) => r.strategy);
    const overallStrat = metricsFromValues(stratValues);
    const overallBench = benchStart != null
      ? metricsFromValues(strategySeries.map((r) => r.benchmark ?? benchStart))
      : null;
    const overall = {
      period_start: strategySeries[0].date,
      period_end: strategySeries[strategySeries.length - 1].date,
      strategy_return_pct: Number(overallStrat.returnPct.toFixed(2)),
      benchmark_return_pct: overallBench ? Number(overallBench.returnPct.toFixed(2)) : null,
      alpha_pct: overallBench ? Number((overallStrat.returnPct - overallBench.returnPct).toFixed(2)) : null,
      volatility_pct: Number(overallStrat.volPct.toFixed(2)),
      sharpe: Number(overallStrat.sharpe.toFixed(2)),
      max_drawdown_pct: Number(overallStrat.maxDDPct.toFixed(2)),
      best_day_pct: Number(overallStrat.bestPct.toFixed(2)),
      worst_day_pct: Number(overallStrat.worstPct.toFixed(2)),
      days: stratValues.length,
    };
    const benchmarkOverall = overallBench
      ? {
          volatility_pct: Number(overallBench.volPct.toFixed(2)),
          sharpe: Number(overallBench.sharpe.toFixed(2)),
          max_drawdown_pct: Number(overallBench.maxDDPct.toFixed(2)),
        }
      : null;

    const daily: PerfBucket[] = [];
    for (let i = 1; i < strategySeries.length; i++) {
      const prev = strategySeries[i - 1];
      const cur = strategySeries[i];
      const sRet = prev.strategy > 0 ? ((cur.strategy - prev.strategy) / prev.strategy) * 100 : 0;
      const bRet =
        prev.benchmark != null && cur.benchmark != null && prev.benchmark > 0
          ? ((cur.benchmark - prev.benchmark) / prev.benchmark) * 100
          : null;
      daily.push({
        period_start: prev.date,
        period_end: cur.date,
        label: cur.date,
        strategy_return_pct: Number(sRet.toFixed(2)),
        benchmark_return_pct: bRet == null ? null : Number(bRet.toFixed(2)),
        alpha_pct: bRet == null ? null : Number((sRet - bRet).toFixed(2)),
        volatility_pct: 0,
        max_drawdown_pct: 0,
        sharpe: 0,
        best_day_pct: Number(sRet.toFixed(2)),
        worst_day_pct: Number(sRet.toFixed(2)),
        days: 1,
      });
    }

    const weekMap = new Map<string, typeof strategySeries>();
    for (const row of strategySeries) {
      const wk = isoWeekStart(row.date);
      const arr = weekMap.get(wk) ?? [];
      arr.push(row);
      weekMap.set(wk, arr);
    }
    const weekKeys = Array.from(weekMap.keys()).sort();
    const weekly: PerfBucket[] = [];
    for (const wk of weekKeys) {
      const rows = weekMap.get(wk)!;
      if (rows.length < 2) continue;
      const sVals = rows.map((r) => r.strategy);
      const bVals = rows.every((r) => r.benchmark != null) ? rows.map((r) => r.benchmark as number) : null;
      const sM = metricsFromValues(sVals);
      const bM = bVals ? metricsFromValues(bVals) : null;
      weekly.push({
        period_start: rows[0].date,
        period_end: rows[rows.length - 1].date,
        label: `Wk of ${wk}`,
        strategy_return_pct: Number(sM.returnPct.toFixed(2)),
        benchmark_return_pct: bM ? Number(bM.returnPct.toFixed(2)) : null,
        alpha_pct: bM ? Number((sM.returnPct - bM.returnPct).toFixed(2)) : null,
        volatility_pct: Number(sM.volPct.toFixed(2)),
        max_drawdown_pct: Number(sM.maxDDPct.toFixed(2)),
        sharpe: Number(sM.sharpe.toFixed(2)),
        best_day_pct: Number(sM.bestPct.toFixed(2)),
        worst_day_pct: Number(sM.worstPct.toFixed(2)),
        days: rows.length,
      });
    }

    return {
      portfolio: {
        id: portfolio.id, name: portfolio.name, currency: portfolio.currency,
        risk_level: portfolio.risk_level, starting_cash: Number(portfolio.starting_cash),
      },
      benchmark: data.benchmark,
      window_days: data.window_days,
      overall,
      benchmarkOverall,
      strategy_series: strategySeries,
      daily,
      weekly,
      empty: false,
    };
  });

export const getComparison = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({ portfolio_ids: z.array(z.string().uuid()).min(1).max(6) }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: portfolios, error } = await context.supabase
      .from("portfolios")
      .select("*")
      .in("id", data.portfolio_ids);
    if (error) throw new Error(error.message);
    const results = await Promise.all(
      (portfolios ?? []).map(async (p) => {
        const [{ data: equity }, simRes, liveRes] = await Promise.all([
          context.supabase
            .from("equity_snapshots")
            .select("snapshot_date,total_value")
            .eq("portfolio_id", p.id)
            .order("snapshot_date", { ascending: true }),
          (p.mode !== "live_prod" && p.mode !== "live_sim")
            ? context.supabase.from("sim_fund_events").select("amount, created_at").eq("portfolio_id", p.id)
            : Promise.resolve({ data: [] as Array<{ amount: unknown; created_at: unknown }> }),
          (p.mode === "live_prod" || p.mode === "live_sim")
            ? context.supabase
                .from("live_broker_log")
                .select("created_at, response, status, method")
                .eq("portfolio_id", p.id)
                .eq("method", "CASH_SYNC")
                .eq("status", 200)
            : Promise.resolve({ data: [] as Array<{ created_at: unknown; response: unknown }> }),
        ]);
        const series = (equity ?? []).map((e) => ({
          snapshot_date: e.snapshot_date as string,
          total_value: Number(e.total_value),
        }));
        const deposits: Array<{ date: string; amount: number }> = [];
        for (const e of (simRes.data ?? []) as Array<{ amount: unknown; created_at: unknown }>) {
          if (!e.created_at) continue;
          const amt = Number(e.amount);
          if (!Number.isFinite(amt)) continue;
          deposits.push({ date: String(e.created_at).slice(0, 10), amount: amt });
        }
        for (const row of (liveRes.data ?? []) as Array<{ created_at: unknown; response: unknown }>) {
          if (!row.created_at) continue;
          const resp = (row.response ?? {}) as { delta?: number | string; startingCashAdjusted?: boolean };
          if (!resp.startingCashAdjusted) continue;
          const amt = Number(resp.delta);
          if (!Number.isFinite(amt) || amt === 0) continue;
          deposits.push({ date: String(row.created_at).slice(0, 10), amount: amt });
        }
        return {
          portfolio: {
            id: p.id,
            name: p.name,
            currency: p.currency,
            risk_level: p.risk_level,
            universe: p.universe,
            starting_cash: Number(p.starting_cash),
            mode: p.mode,
          },
          series,
          deposits,
          metrics: computeMetrics(series, Number(p.starting_cash)),
        };
      }),
    );
    return { results };
  });

// Trade-by-trade comparison across multiple portfolios over a window.
export const getTradeComparison = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_ids: z.array(z.string().uuid()).min(1).max(6),
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: portfolios, error } = await context.supabase
      .from("portfolios")
      .select("id, name, risk_level, currency, starting_cash")
      .in("id", data.portfolio_ids);
    if (error) throw new Error(error.message);

    const results = await Promise.all(
      (portfolios ?? []).map(async (p) => {
        let q = context.supabase
          .from("decisions")
          .select("run_date, rationale, portfolio_value, raw")
          .eq("portfolio_id", p.id)
          .order("run_date", { ascending: true });
        if (data.from) q = q.gte("run_date", data.from);
        if (data.to) q = q.lte("run_date", data.to);
        const { data: decs } = await q;

        type Row = {
          date: string;
          symbol: string;
          side: "buy" | "sell";
          intent_pct: number | null;
          executed_qty: number;
          executed_value: number;
          price: number;
          rejected: string | null;
          reason: string;
          signal_weights: Record<string, number> | null;
          signals: Record<string, number | null> | null;
          asset_class: string | null;
        };
        const rows: Row[] = [];
        for (const d of decs ?? []) {
          const raw = (d.raw ?? {}) as {
            orders?: Array<{
              symbol?: string;
              side?: string;
              percent?: number;
              reason?: string;
              signal_weights?: Record<string, number>;
            }>;
            executed?: Array<{
              symbol?: string;
              side?: string;
              quantity?: number;
              value?: number;
              price?: number;
              reason?: string;
              rejected?: string | null;
            }>;
            signals?: Array<{
              symbol: string;
              asset_class?: string;
              sma20?: number | null;
              sma50?: number | null;
              rsi14?: number | null;
              change5d?: number | null;
              change30d?: number | null;
              vol20d?: number | null;
              price?: number | null;
            }>;
          };
          const sigBySym = new Map(
            (raw.signals ?? []).map((s) => [s.symbol.toUpperCase(), s] as const),
          );
          const intentBySym = new Map(
            (raw.orders ?? [])
              .filter((o) => o.symbol)
              .map(
                (o) =>
                  [
                    (o.symbol ?? "").toUpperCase() + "|" + (o.side ?? ""),
                    o,
                  ] as const,
              ),
          );
          for (const ex of raw.executed ?? []) {
            const sym = (ex.symbol ?? "").toUpperCase();
            if (!sym) continue;
            const side = (ex.side === "sell" ? "sell" : "buy") as "buy" | "sell";
            const intent = intentBySym.get(sym + "|" + side);
            const sig = sigBySym.get(sym);
            rows.push({
              date: d.run_date as string,
              symbol: sym,
              side,
              intent_pct: intent?.percent ?? null,
              executed_qty: Number(ex.quantity ?? 0),
              executed_value: Number(ex.value ?? 0),
              price: Number(ex.price ?? 0),
              rejected: ex.rejected ?? null,
              reason: String(ex.reason ?? intent?.reason ?? ""),
              signal_weights: intent?.signal_weights ?? null,
              signals: sig
                ? {
                    sma20: sig.sma20 ?? null,
                    sma50: sig.sma50 ?? null,
                    rsi14: sig.rsi14 ?? null,
                    change5d: sig.change5d ?? null,
                    change30d: sig.change30d ?? null,
                    vol20d: sig.vol20d ?? null,
                  }
                : null,
              asset_class: sig?.asset_class ?? null,
            });
          }
        }

        return {
          portfolio: {
            id: p.id,
            name: p.name,
            risk_level: p.risk_level,
            currency: p.currency,
            starting_cash: Number(p.starting_cash),
          },
          rows,
        };
      }),
    );
    return { results };
  });
