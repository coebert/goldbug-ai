// Server functions exposed to the UI. All authenticated via requireSupabaseAuth.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { GLOBAL_EVENTS } from "./global-events";

const RiskEnum = z.enum(["conservative", "balanced", "aggressive"]);
const AssetClassEnum = z.enum(["stock", "etf", "crypto", "commodity", "fx"]);

const CreatePortfolioSchema = z.object({
  name: z.string().min(1).max(80).default("My Portfolio"),
  starting_cash: z.number().min(10).max(1_000_000).default(1000),
  currency: z.enum(["GBP", "USD", "EUR"]).default("GBP"),
  risk_level: RiskEnum.default("balanced"),
  universe: z.array(AssetClassEnum).min(1).default(["stock", "etf", "crypto", "commodity", "fx"]),
  mode: z.enum(["backtest", "paper"]).default("backtest"),
});

export const createPortfolio = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => CreatePortfolioSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("portfolios")
      .insert({
        user_id: context.userId,
        name: data.name,
        starting_cash: data.starting_cash,
        current_cash: data.starting_cash,
        currency: data.currency,
        risk_level: data.risk_level,
        universe: data.universe,
        mode: data.mode,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id };
  });

export const listPortfolios = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("portfolios")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  });

// Combined equity across all of the user's portfolios.
// Returns per-portfolio series plus a merged "total" series summing each
// portfolio's latest-known value (forward-filled) at every date on the axis.
export const getAllPortfoliosEquity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: portfolios, error } = await context.supabase
      .from("portfolios")
      .select("id,name,currency,starting_cash,current_cash,created_at")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    const list = portfolios ?? [];
    if (list.length === 0) return { portfolios: [], series: [], currency: "GBP" as string };

    // Phase 8 — one query for all portfolios instead of N (uses new
    // (portfolio_id, snapshot_date DESC) index).
    const ids = list.map((p) => p.id);
    const { data: allEq } = await context.supabase
      .from("equity_snapshots")
      .select("portfolio_id,snapshot_date,total_value")
      .in("portfolio_id", ids)
      .order("snapshot_date", { ascending: true });

    const byPortfolio = new Map<string, Array<{ date: string; value: number }>>();
    for (const e of allEq ?? []) {
      const arr = byPortfolio.get(e.portfolio_id as string) ?? [];
      arr.push({ date: e.snapshot_date as string, value: Number(e.total_value) });
      byPortfolio.set(e.portfolio_id as string, arr);
    }

    const perPortfolio = list.map((p) => ({
      id: p.id as string,
      name: p.name as string,
      currency: p.currency as string,
      starting_cash: Number(p.starting_cash),
      current_cash: Number(p.current_cash),
      series: byPortfolio.get(p.id as string) ?? [],
    }));

    const today = new Date().toISOString().slice(0, 10);
    const allDates = new Set<string>();
    for (const p of perPortfolio) {
      if (p.series.length === 0) allDates.add(today);
      else for (const r of p.series) allDates.add(r.date);
    }
    const dates = [...allDates].sort();

    const series = dates.map((d) => {
      let total = 0;
      const perId: Record<string, number> = {};
      for (const p of perPortfolio) {
        let v = p.starting_cash;
        if (p.series.length === 0) {
          v = p.current_cash;
        } else {
          for (const r of p.series) {
            if (r.date <= d) v = r.value;
            else break;
          }
        }
        perId[p.id] = v;
        total += v;
      }
      return { date: d, total, ...perId } as Record<string, string | number>;
    });

    const currency = perPortfolio[0]?.currency ?? "GBP";
    return {
      portfolios: perPortfolio.map((p) => ({ id: p.id, name: p.name, currency: p.currency })),
      series,
      currency,
    };
  });

export const getPortfolio = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const [{ data: portfolio }, { data: holdings }, { data: trades }, { data: decisions }, { data: equity }] =
      await Promise.all([
        context.supabase.from("portfolios").select("*").eq("id", data.id).single(),
        context.supabase.from("holdings").select("*").eq("portfolio_id", data.id),
        context.supabase
          .from("trades")
          .select("*")
          .eq("portfolio_id", data.id)
          .order("executed_at", { ascending: false })
          .limit(200),
        context.supabase
          .from("decisions")
          .select("*")
          .eq("portfolio_id", data.id)
          .order("run_date", { ascending: false })
          .limit(60),
        context.supabase
          .from("equity_snapshots")
          .select("*")
          .eq("portfolio_id", data.id)
          .order("snapshot_date", { ascending: true }),
      ]);
    if (!portfolio) throw new Error("Portfolio not found");
    return {
      portfolio,
      holdings: holdings ?? [],
      trades: trades ?? [],
      decisions: decisions ?? [],
      equity: equity ?? [],
    };
  });

export const deletePortfolio = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("portfolios").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const RiskConfigSchema = z.object({
  asset_class_limits: z
    .object({
      stock: z.number().min(0).max(1).optional(),
      etf: z.number().min(0).max(1).optional(),
      crypto: z.number().min(0).max(1).optional(),
      commodity: z.number().min(0).max(1).optional(),
      fx: z.number().min(0).max(1).optional(),
    })
    .partial()
    .default({}),
  per_symbol_limit_pct: z.number().min(0).max(1).nullable().default(null),
  stop_loss_pct: z.number().min(0).max(0.9).default(0.1),
  take_profit_pct: z.number().min(0).max(5).default(0.25),
  atr_trailing_mult: z.number().min(0).max(10).default(3),
  max_hold_days: z.number().int().min(0).max(3650).default(0),
  volatility_sizing: z.boolean().default(true),
  vol_target_pct: z.number().min(0.001).max(0.1).default(0.015),
});

export const updateRiskConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        risk_config: RiskConfigSchema,
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("portfolios")
      .update({ risk_config: data.risk_config })
      .eq("id", data.portfolio_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// -----------------------------------------------------------------------
// Execution calibration — estimates spread / slippage / commission from
// recent OHLCV and updates portfolios.risk_config.execution_params.
// -----------------------------------------------------------------------
export const calibrateExecution = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        window_days: z.number().int().min(20).max(365).default(90),
        apply: z.boolean().default(true),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: p, error } = await context.supabase
      .from("portfolios")
      .select("id, universe, risk_config")
      .eq("id", data.portfolio_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!p) throw new Error("Portfolio not found");

    const { filterUniverse, parseRiskConfig } = await import("./universe.server");
    const { calibrateExecution: run } = await import("./execution-calibration.server");
    const classes = Array.isArray(p.universe) ? (p.universe as string[]) : [];
    const symbols = filterUniverse(classes as Parameters<typeof filterUniverse>[0]).map((u) => u.symbol);
    if (!symbols.length) throw new Error("Portfolio universe is empty");

    const summary = await run(symbols, { lookbackDays: data.window_days });

    if (data.apply) {
      const cfg = parseRiskConfig(p.risk_config);
      const nextCfg = {
        ...cfg,
        execution_params: {
          slippage_bps: summary.recommended.slippage_bps,
          commission_bps: summary.recommended.commission_bps,
          spread_atr_frac: summary.recommended.spread_atr_frac,
          adv_participation: summary.recommended.adv_participation,
          min_trade_value: summary.recommended.min_trade_value,
        },
        execution_calibration: {
          as_of: summary.as_of,
          window_days: summary.window_days,
          n_symbols: summary.n_symbols,
          notes: summary.notes,
        },
      };
      const { error: upErr } = await context.supabase
        .from("portfolios")
        .update({ risk_config: nextCfg })
        .eq("id", data.portfolio_id);
      if (upErr) throw new Error(upErr.message);
    }

    return summary;
  });




export const resetPortfolio = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { data: p } = await context.supabase
      .from("portfolios")
      .select("starting_cash")
      .eq("id", data.id)
      .single();
    if (!p) throw new Error("Portfolio not found");
    await context.supabase.from("holdings").delete().eq("portfolio_id", data.id);
    await context.supabase.from("trades").delete().eq("portfolio_id", data.id);
    await context.supabase.from("decisions").delete().eq("portfolio_id", data.id);
    await context.supabase.from("equity_snapshots").delete().eq("portfolio_id", data.id);
    await context.supabase
      .from("portfolios")
      .update({ current_cash: p.starting_cash, last_run_date: null })
      .eq("id", data.id);
    return { ok: true };
  });

export const runOneDay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        as_of: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    // Verify user owns portfolio (RLS via context.supabase)
    const { data: owned } = await context.supabase
      .from("portfolios")
      .select("id")
      .eq("id", data.portfolio_id)
      .single();
    if (!owned) throw new Error("Portfolio not found");
    const { runDailyTick } = await import("./trading-engine.server");
    const asOf = data.as_of ?? new Date().toISOString().slice(0, 10);
    const result = await runDailyTick(data.portfolio_id, asOf);
    return {
      briefing: result.decision.briefing,
      rationale: result.decision.rationale,
      totalValue: result.totalValue,
      executedCount: result.executed.filter((e) => !e.rejected).length,
    };
  });

export const runBacktest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        // number of trading days to simulate, ending today
        days: z.number().int().min(3).max(30).default(10),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: owned } = await context.supabase
      .from("portfolios")
      .select("id")
      .eq("id", data.portfolio_id)
      .single();
    if (!owned) throw new Error("Portfolio not found");
    const { runDailyTick, snapshotPortfolio } = await import("./trading-engine.server");

    // Reset portfolio first
    const { data: p } = await context.supabase
      .from("portfolios")
      .select("starting_cash")
      .eq("id", data.portfolio_id)
      .single();
    if (p) {
      await context.supabase.from("holdings").delete().eq("portfolio_id", data.portfolio_id);
      await context.supabase.from("trades").delete().eq("portfolio_id", data.portfolio_id);
      await context.supabase.from("decisions").delete().eq("portfolio_id", data.portfolio_id);
      await context.supabase
        .from("equity_snapshots")
        .delete()
        .eq("portfolio_id", data.portfolio_id);
      await context.supabase
        .from("portfolios")
        .update({ current_cash: p.starting_cash, last_run_date: null })
        .eq("id", data.portfolio_id);
    }

    // Build list of business days (skip weekends) ending yesterday
    const dates: string[] = [];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    let cursor = new Date(today);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    while (dates.length < data.days) {
      const dow = cursor.getUTCDay();
      if (dow !== 0 && dow !== 6) dates.unshift(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      if (dates.length > 60) break;
    }

    let lastTotal = 0;
    for (const d of dates) {
      try {
        const r = await runDailyTick(data.portfolio_id, d, { skipNews: true });
        lastTotal = r.totalValue;
      } catch (err) {
        console.error(`backtest ${d} failed`, err);
        await snapshotPortfolio(data.portfolio_id, d).catch(() => {});
      }
    }
    return { ok: true, days: dates.length, finalValue: lastTotal };
  });

// ---------- Comparison ----------

function computeMetrics(equity: { snapshot_date: string; total_value: number }[], startingCash: number) {
  if (equity.length === 0) {
    return {
      totalReturnPct: 0,
      maxDrawdownPct: 0,
      sharpe: 0,
      volatilityPct: 0,
      bestDayPct: 0,
      worstDayPct: 0,
      days: 0,
    };
  }
  const values = equity.map((e) => Number(e.total_value));
  const finalValue = values[values.length - 1];
  const totalReturnPct = ((finalValue - startingCash) / startingCash) * 100;

  // Max drawdown
  let peak = values[0];
  let maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  // Daily returns based on previous close
  const rets: number[] = [];
  let prev = startingCash;
  for (const v of values) {
    if (prev > 0) rets.push((v - prev) / prev);
    prev = v;
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  const std = Math.sqrt(variance);
  // Annualise assuming ~252 trading days
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  const volatilityPct = std * Math.sqrt(252) * 100;
  const best = rets.length ? Math.max(...rets) : 0;
  const worst = rets.length ? Math.min(...rets) : 0;

  return {
    totalReturnPct,
    maxDrawdownPct: maxDD * 100,
    sharpe,
    volatilityPct,
    bestDayPct: best * 100,
    worstDayPct: worst * 100,
    days: values.length,
  };
}

// ============================================================================
// Performance report: daily & weekly bucketed returns vs SPY benchmark.
// ============================================================================

type PerfBucket = {
  period_start: string;
  period_end: string;
  label: string;
  strategy_return_pct: number;
  benchmark_return_pct: number | null;
  alpha_pct: number | null;
  volatility_pct: number;
  max_drawdown_pct: number;
  sharpe: number;
  best_day_pct: number;
  worst_day_pct: number;
  days: number;
};

function isoWeekStart(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}
function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function metricsFromValues(values: number[]) {
  if (values.length < 2) {
    return { returnPct: 0, volPct: 0, sharpe: 0, maxDDPct: 0, bestPct: 0, worstPct: 0 };
  }
  const start = values[0];
  const end = values[values.length - 1];
  const returnPct = start > 0 ? ((end - start) / start) * 100 : 0;
  let peak = values[0];
  let maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? (v - peak) / peak : 0;
    if (dd < maxDD) maxDD = dd;
  }
  const rets: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) rets.push((values[i] - values[i - 1]) / values[i - 1]);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  const volPct = std * Math.sqrt(252) * 100;
  const best = rets.length ? Math.max(...rets) * 100 : 0;
  const worst = rets.length ? Math.min(...rets) * 100 : 0;
  return { returnPct, volPct, sharpe, maxDDPct: maxDD * 100, bestPct: best, worstPct: worst };
}

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

    // Fetch benchmark candles for the same window.
    const { getDailyCandlesRange } = await import("./market-data.server");
    let benchCandles: Array<{ date: string; close: number }> = [];
    try {
      const raw = await getDailyCandlesRange(data.benchmark, windowed[0].date, asOf);
      benchCandles = raw.map((c) => ({ date: c.date, close: Number(c.close) }));
    } catch {
      benchCandles = [];
    }
    const benchByDate = new Map(benchCandles.map((c) => [c.date, c.close]));
    // Normalize benchmark to strategy's starting portfolio value at window start.
    const startVal = windowed[0].value;
    const benchStart = benchCandles[0]?.close ?? null;

    // Align: for each strategy date, pick the last known benchmark close ≤ date.
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

    // Overall metrics on the windowed series
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

    // Daily rows — one per snapshot day (last N days, chronological desc)
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

    // Weekly buckets — group by ISO week (Mon start)
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
        const { data: equity } = await context.supabase
          .from("equity_snapshots")
          .select("snapshot_date,total_value")
          .eq("portfolio_id", p.id)
          .order("snapshot_date", { ascending: true });
        const series = (equity ?? []).map((e) => ({
          snapshot_date: e.snapshot_date as string,
          total_value: Number(e.total_value),
        }));
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
          metrics: computeMetrics(series, Number(p.starting_cash)),
        };
      }),
    );
    return { results };
  });

// Trade-by-trade comparison across multiple portfolios over a window.
// Returns per-portfolio decision rows so the client can pivot by (date, symbol)
// and highlight divergences (buy/sell/blocked/skipped + signal weights).
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

export const runBacktestMany = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_ids: z.array(z.string().uuid()).min(1).max(6),
        days: z.number().int().min(3).max(30).default(10),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: owned } = await context.supabase
      .from("portfolios")
      .select("id")
      .in("id", data.portfolio_ids);
    const ids = (owned ?? []).map((o) => o.id);
    const { runDailyTick, snapshotPortfolio } = await import("./trading-engine.server");

    // Build shared trading-day list
    const dates: string[] = [];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const cursor = new Date(today);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    while (dates.length < data.days) {
      const dow = cursor.getUTCDay();
      if (dow !== 0 && dow !== 6) dates.unshift(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      if (dates.length > 60) break;
    }

    for (const id of ids) {
      const { data: p } = await context.supabase
        .from("portfolios")
        .select("starting_cash")
        .eq("id", id)
        .single();
      if (!p) continue;
      await context.supabase.from("holdings").delete().eq("portfolio_id", id);
      await context.supabase.from("trades").delete().eq("portfolio_id", id);
      await context.supabase.from("decisions").delete().eq("portfolio_id", id);
      await context.supabase.from("equity_snapshots").delete().eq("portfolio_id", id);
      await context.supabase
        .from("portfolios")
        .update({ current_cash: p.starting_cash, last_run_date: null })
        .eq("id", id);
      for (const d of dates) {
        try {
          await runDailyTick(id, d, { skipNews: true });
        } catch (err) {
          console.error(`backtest ${id} ${d} failed`, err);
          await snapshotPortfolio(id, d).catch(() => {});
        }
      }
    }
    return { ok: true, ran: ids.length, days: dates.length };
  });

// ---------- Diagnostics ----------

type ExecutedOrder = {
  symbol?: string;
  side?: string;
  price?: number;
  quantity?: number;
  rejected?: string | null;
  reason?: string;
};

type AiOrder = {
  symbol?: string;
  side?: string;
  percent?: number;
  signal_weights?: Record<string, number>;
};

const SIGNAL_KEYS = ["sma_trend", "rsi", "price_change", "news_sentiment", "volatility"] as const;

function addBusinessDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export const getDiagnostics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        horizon_days: z.number().int().min(1).max(20).default(5),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    // Ownership check via RLS
    const { data: owned } = await context.supabase
      .from("portfolios")
      .select("id, starting_cash")
      .eq("id", data.portfolio_id)
      .single();
    if (!owned) throw new Error("Portfolio not found");

    const [{ data: decisions }, { data: equity }] = await Promise.all([
      context.supabase
        .from("decisions")
        .select("id, run_date, raw, portfolio_value")
        .eq("portfolio_id", data.portfolio_id)
        .order("run_date", { ascending: true }),
      context.supabase
        .from("equity_snapshots")
        .select("snapshot_date, total_value")
        .eq("portfolio_id", data.portfolio_id)
        .order("snapshot_date", { ascending: true }),
    ]);

    const decRows = (decisions ?? []) as Array<{
      id: string;
      run_date: string;
      portfolio_value: number | null;
      raw: {
        orders?: AiOrder[];
        executed?: ExecutedOrder[];
      } | null;
    }>;

    // Collect all forward-price lookups we need
    const needed = new Map<string, Set<string>>(); // symbol -> set of dates
    for (const d of decRows) {
      const target = addBusinessDays(d.run_date, data.horizon_days);
      for (const ex of d.raw?.executed ?? []) {
        if (ex.rejected || !ex.symbol || !ex.price || !ex.side) continue;
        if (!needed.has(ex.symbol)) needed.set(ex.symbol, new Set());
        needed.get(ex.symbol)!.add(target);
      }
    }
    const symbols = [...needed.keys()];
    const priceLookup = new Map<string, Map<string, number>>();
    if (symbols.length > 0) {
      // Fetch a window of prices per symbol covering the horizon
      const { data: prices } = await context.supabase
        .from("price_cache")
        .select("symbol, price_date, close")
        .in("symbol", symbols)
        .order("price_date", { ascending: true });
      for (const row of prices ?? []) {
        if (!priceLookup.has(row.symbol)) priceLookup.set(row.symbol, new Map());
        priceLookup.get(row.symbol)!.set(row.price_date as string, Number(row.close));
      }
    }
    function findClose(symbol: string, targetDate: string): number | null {
      const m = priceLookup.get(symbol);
      if (!m) return null;
      // Prefer exact, else next available forward, else last available
      if (m.has(targetDate)) return m.get(targetDate)!;
      const dates = [...m.keys()].sort();
      for (const d of dates) {
        if (d >= targetDate) return m.get(d)!;
      }
      return dates.length ? m.get(dates[dates.length - 1])! : null;
    }

    // Per-order outcomes
    type Outcome = {
      run_date: string;
      symbol: string;
      side: "buy" | "sell";
      entryPrice: number;
      exitPrice: number;
      forwardReturn: number; // signed for "predicted direction correct"
      conviction: number; // 0..1
      topSignal: string;
      weights: Record<string, number>;
      win: boolean;
    };
    const outcomes: Outcome[] = [];
    let totalOrders = 0;
    let executedOrders = 0;
    let rejectedCount = 0;
    const buySellCounts = { buy: 0, sell: 0 };

    for (const d of decRows) {
      const orders = d.raw?.orders ?? [];
      const executed = d.raw?.executed ?? [];
      totalOrders += orders.length;

      // Map order weights by symbol+side
      const weightsByKey = new Map<string, AiOrder>();
      for (const o of orders) {
        if (o.symbol && o.side) weightsByKey.set(`${o.symbol}:${o.side}`, o);
      }

      for (const ex of executed) {
        if (!ex.symbol || !ex.side) continue;
        if (ex.rejected) {
          rejectedCount++;
          continue;
        }
        executedOrders++;
        if (ex.side === "buy") buySellCounts.buy++;
        else if (ex.side === "sell") buySellCounts.sell++;

        const target = addBusinessDays(d.run_date, data.horizon_days);
        const entry = Number(ex.price);
        const exit = findClose(ex.symbol, target);
        if (!entry || !exit) continue;
        const rawRet = (exit - entry) / entry;
        // For sells the "prediction" was that price would go down
        const directional = ex.side === "buy" ? rawRet : -rawRet;
        const linked = weightsByKey.get(`${ex.symbol}:${ex.side}`);
        const w = linked?.signal_weights ?? {};
        const weightVals = SIGNAL_KEYS.map((k) => Number(w[k] ?? 0));
        const topIdx = weightVals.indexOf(Math.max(...weightVals));
        const topSignal = SIGNAL_KEYS[topIdx] ?? "unknown";
        const conviction = Math.min(1, Math.max(0, (linked?.percent ?? 0) / 100));
        outcomes.push({
          run_date: d.run_date,
          symbol: ex.symbol,
          side: ex.side as "buy" | "sell",
          entryPrice: entry,
          exitPrice: exit,
          forwardReturn: directional,
          conviction,
          topSignal,
          weights: Object.fromEntries(SIGNAL_KEYS.map((k, i) => [k, weightVals[i]])),
          win: directional > 0,
        });
      }
    }

    const wins = outcomes.filter((o) => o.win).length;
    const winRate = outcomes.length ? wins / outcomes.length : 0;
    const avgForwardReturn = mean(outcomes.map((o) => o.forwardReturn));

    // Calibration by conviction bucket (order size percent)
    const buckets = [
      { label: "0-10%", min: 0, max: 0.1 },
      { label: "10-25%", min: 0.1, max: 0.25 },
      { label: "25-50%", min: 0.25, max: 0.5 },
      { label: "50-100%", min: 0.5, max: 1.01 },
    ];
    const calibration = buckets.map((b) => {
      const items = outcomes.filter((o) => o.conviction >= b.min && o.conviction < b.max);
      return {
        bucket: b.label,
        n: items.length,
        winRate: items.length ? items.filter((i) => i.win).length / items.length : 0,
        avgReturn: mean(items.map((i) => i.forwardReturn)),
      };
    });

    // Calibration by top-signal
    const perSignal = SIGNAL_KEYS.map((k) => {
      const items = outcomes.filter((o) => o.topSignal === k);
      return {
        signal: k,
        n: items.length,
        winRate: items.length ? items.filter((i) => i.win).length / items.length : 0,
        avgReturn: mean(items.map((i) => i.forwardReturn)),
      };
    });

    // Drawdown from equity snapshots
    const equityRows = (equity ?? []).map((e) => Number(e.total_value));
    let peak = equityRows[0] ?? Number(owned.starting_cash);
    let maxDD = 0;
    for (const v of equityRows) {
      if (v > peak) peak = v;
      const dd = (v - peak) / peak;
      if (dd < maxDD) maxDD = dd;
    }
    const currentValue = equityRows[equityRows.length - 1] ?? Number(owned.starting_cash);
    const currentDD = peak > 0 ? (currentValue - peak) / peak : 0;

    // Behavior shift: split decisions into recent vs prior windows
    const half = Math.floor(decRows.length / 2);
    const prior = decRows.slice(0, half);
    const recent = decRows.slice(half);
    function avgWeights(rows: typeof decRows) {
      const acc: Record<string, number[]> = {};
      SIGNAL_KEYS.forEach((k) => (acc[k] = []));
      for (const r of rows) {
        for (const o of r.raw?.orders ?? []) {
          const w = o.signal_weights;
          if (!w) continue;
          SIGNAL_KEYS.forEach((k) => acc[k].push(Number(w[k] ?? 0)));
        }
      }
      return Object.fromEntries(SIGNAL_KEYS.map((k) => [k, mean(acc[k])]));
    }
    const priorWeights = avgWeights(prior);
    const recentWeights = avgWeights(recent);
    const weightDrift = SIGNAL_KEYS.map((k) => ({
      signal: k,
      prior: priorWeights[k],
      recent: recentWeights[k],
      delta: recentWeights[k] - priorWeights[k],
    }));

    const priorOrdersPerDay = prior.length ? mean(prior.map((r) => (r.raw?.orders ?? []).length)) : 0;
    const recentOrdersPerDay = recent.length ? mean(recent.map((r) => (r.raw?.orders ?? []).length)) : 0;

    function buySellRatio(rows: typeof decRows) {
      let b = 0, s = 0;
      for (const r of rows)
        for (const o of r.raw?.orders ?? []) {
          if (o.side === "buy") b++;
          else if (o.side === "sell") s++;
        }
      return b + s === 0 ? 0.5 : b / (b + s);
    }
    const priorBuyRatio = buySellRatio(prior);
    const recentBuyRatio = buySellRatio(recent);

    // Flags
    const flags: Array<{ severity: "info" | "warn"; message: string }> = [];
    if (decRows.length < 4) {
      flags.push({
        severity: "info",
        message: `Only ${decRows.length} decision${decRows.length === 1 ? "" : "s"} recorded — run more days for reliable diagnostics.`,
      });
    }
    for (const d of weightDrift) {
      if (Math.abs(d.delta) >= 15) {
        flags.push({
          severity: "warn",
          message: `${d.signal.replace("_", " ")} weighting shifted ${d.delta > 0 ? "up" : "down"} by ${Math.abs(d.delta).toFixed(0)}pp (${d.prior.toFixed(0)}% → ${d.recent.toFixed(0)}%).`,
        });
      }
    }
    if (prior.length >= 2 && recent.length >= 2) {
      if (priorOrdersPerDay > 0 && Math.abs(recentOrdersPerDay - priorOrdersPerDay) / Math.max(priorOrdersPerDay, 0.5) >= 0.5) {
        flags.push({
          severity: "warn",
          message: `Order frequency ${recentOrdersPerDay > priorOrdersPerDay ? "up" : "down"}: ${priorOrdersPerDay.toFixed(1)} → ${recentOrdersPerDay.toFixed(1)} orders/day.`,
        });
      }
      if (Math.abs(recentBuyRatio - priorBuyRatio) >= 0.25) {
        flags.push({
          severity: "warn",
          message: `Buy/sell mix shifted: ${(priorBuyRatio * 100).toFixed(0)}% buys → ${(recentBuyRatio * 100).toFixed(0)}% buys.`,
        });
      }
    }
    if (currentDD <= -0.1) {
      flags.push({
        severity: "warn",
        message: `Currently ${(currentDD * 100).toFixed(1)}% below peak equity.`,
      });
    }
    if (outcomes.length >= 5 && winRate < 0.4) {
      flags.push({
        severity: "warn",
        message: `Win rate ${(winRate * 100).toFixed(0)}% over ${outcomes.length} trades — below the 40% floor.`,
      });
    }

    // Rolling win rate for trend chart (window of 5)
    const rolling: Array<{ index: number; run_date: string; winRate: number }> = [];
    const windowSize = 5;
    for (let i = 0; i < outcomes.length; i++) {
      const from = Math.max(0, i - windowSize + 1);
      const slice = outcomes.slice(from, i + 1);
      rolling.push({
        index: i + 1,
        run_date: outcomes[i].run_date,
        winRate: slice.filter((s) => s.win).length / slice.length,
      });
    }

    // Event impact: bucket outcomes into major event windows (plus a "Calm" baseline)
    type EventBucket = {
      id: string;
      label: string;
      category: string;
      severity: number;
      start: string;
      end: string;
      n: number;
      wins: number;
      avgReturn: number;
      avgConviction: number;
      weights: Record<string, number>;
      topSignal: string;
    };
    const bucketMap = new Map<string, EventBucket & { retSum: number; convSum: number; weightSums: Record<string, number> }>();
    function getBucket(key: string, meta: Omit<EventBucket, "n" | "wins" | "avgReturn" | "avgConviction" | "weights" | "topSignal">) {
      let b = bucketMap.get(key);
      if (!b) {
        b = {
          ...meta,
          n: 0,
          wins: 0,
          avgReturn: 0,
          avgConviction: 0,
          weights: {},
          topSignal: "",
          retSum: 0,
          convSum: 0,
          weightSums: {},
        };
        bucketMap.set(key, b);
      }
      return b;
    }
    for (const o of outcomes) {
      const hits = GLOBAL_EVENTS.filter((e) => o.run_date >= e.start && o.run_date <= e.end);
      const targets = hits.length
        ? hits.map((e) => ({
            key: e.id,
            meta: { id: e.id, label: e.label, category: e.category, severity: e.severity, start: e.start, end: e.end },
          }))
        : [{ key: "__calm", meta: { id: "__calm", label: "Calm periods (no major event)", category: "shock", severity: 0, start: "", end: "" } }];
      for (const t of targets) {
        const b = getBucket(t.key, t.meta);
        b.n++;
        if (o.win) b.wins++;
        b.retSum += o.forwardReturn;
        b.convSum += o.conviction;
        for (const [k, v] of Object.entries(o.weights)) {
          b.weightSums[k] = (b.weightSums[k] ?? 0) + Number(v);
        }
      }
    }
    const eventImpact = [...bucketMap.values()]
      .filter((b) => b.n >= 1)
      .map((b) => {
        const weights: Record<string, number> = {};
        let topSignal = "";
        let topVal = -1;
        for (const [k, v] of Object.entries(b.weightSums)) {
          const avg = v / b.n;
          weights[k] = avg;
          if (avg > topVal) {
            topVal = avg;
            topSignal = k;
          }
        }
        return {
          id: b.id,
          label: b.label,
          category: b.category,
          severity: b.severity,
          start: b.start,
          end: b.end,
          n: b.n,
          winRate: b.n ? b.wins / b.n : 0,
          avgReturn: b.n ? b.retSum / b.n : 0,
          avgConviction: b.n ? b.convSum / b.n : 0,
          weights,
          topSignal,
        };
      })
      .sort((a, b) => (a.id === "__calm" ? 1 : b.id === "__calm" ? -1 : b.n - a.n));

    return {
      summary: {
        decisions: decRows.length,
        totalOrders,
        executedOrders,
        rejectedCount,
        evaluatedOutcomes: outcomes.length,
        horizonDays: data.horizon_days,
        winRate,
        avgForwardReturnPct: avgForwardReturn * 100,
        maxDrawdownPct: maxDD * 100,
        currentDrawdownPct: currentDD * 100,
      },
      calibration,
      perSignal,
      weightDrift,
      behavior: {
        priorOrdersPerDay,
        recentOrdersPerDay,
        priorBuyRatio,
        recentBuyRatio,
        priorDecisions: prior.length,
        recentDecisions: recent.length,
      },
      flags,
      rolling,
      eventImpact,
    };
  });

// ---------- Long-horizon backtest (rule-based, 10-50 years) ----------

export const runLongHorizonBacktest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        rebalance: z.enum(["monthly", "quarterly"]).default("monthly"),
        top_k: z.number().int().min(2).max(12).default(6),
        commission_bps: z.number().min(0).max(500).default(5),
        slippage_bps: z.number().min(0).max(500).default(10),
        min_trade_value: z.number().min(0).max(100000).default(25),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: p, error } = await context.supabase
      .from("portfolios")
      .select("id, starting_cash, currency, risk_level, risk_config")
      .eq("id", data.portfolio_id)
      .single();
    if (error || !p) throw new Error("Portfolio not found");
    const { runLongHorizonBacktest: run, LONG_HORIZON_UNIVERSE } = await import(
      "./long-horizon.server"
    );
    const result = await run({
      from: data.from,
      to: data.to,
      startingCash: Number(p.starting_cash),
      currency: p.currency ?? "GBP",
      riskLevel: p.risk_level ?? "balanced",
      riskConfig: p.risk_config,
      universe: LONG_HORIZON_UNIVERSE,
      rebalance: data.rebalance,
      topK: data.top_k,
      execution: {
        commission_bps: data.commission_bps,
        slippage_bps: data.slippage_bps,
        min_trade_value: data.min_trade_value,
      },
    });
    return result;
  });

// ---------------- Regime detection ----------------

export const getCurrentRegime = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("market_regimes")
      .select("*")
      .order("as_of", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data;
  });

export const getRegimeHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ days: z.number().min(1).max(365).default(90) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: rows } = await context.supabase
      .from("market_regimes")
      .select("*")
      .order("as_of", { ascending: false })
      .limit(data.days);
    return (rows ?? []).slice().reverse();
  });

export const refreshRegimeNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { detectAndPersistRegime } = await import("./regime-detector.server");
    const today = new Date().toISOString().slice(0, 10);
    return await detectAndPersistRegime(today);
  });

export const getDivergenceNarratives = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolio_ids: z.array(z.string().uuid()).min(2).max(6),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().min(1).max(10).default(5),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: portfolios, error: pErr } = await context.supabase
      .from("portfolios")
      .select("id, name, risk_level, risk_config")
      .in("id", data.portfolio_ids);
    if (pErr) throw new Error(pErr.message);
    const pById = new Map((portfolios ?? []).map((p) => [p.id, p]));
    const ordered = data.portfolio_ids
      .map((id) => pById.get(id))
      .filter((x): x is NonNullable<typeof x> => !!x);

    type Row = {
      date: string;
      symbol: string;
      side: "buy" | "sell";
      intent_pct: number | null;
      executed_value: number;
      price: number;
      rejected: string | null;
      reason: string;
      signal_weights: Record<string, number> | null;
      signals: Record<string, number | null> | null;
    };
    type PerPortfolio = {
      portfolio_id: string;
      name: string;
      risk_level: string;
      rows: Row[];
      regime?: string | null;
    };

    const perP: PerPortfolio[] = await Promise.all(
      ordered.map(async (p) => {
        let q = context.supabase
          .from("decisions")
          .select("run_date, raw")
          .eq("portfolio_id", p.id)
          .order("run_date", { ascending: true });
        if (data.from) q = q.gte("run_date", data.from);
        if (data.to) q = q.lte("run_date", data.to);
        const { data: decs } = await q;
        const rows: Row[] = [];
        let regime: string | null = null;
        for (const d of decs ?? []) {
          const raw = (d.raw ?? {}) as {
            orders?: Array<{ symbol?: string; side?: string; percent?: number; reason?: string; signal_weights?: Record<string, number> }>;
            executed?: Array<{ symbol?: string; side?: string; value?: number; price?: number; reason?: string; rejected?: string | null }>;
            signals?: Array<{ symbol: string; sma20?: number | null; sma50?: number | null; rsi14?: number | null; change5d?: number | null; change30d?: number | null; vol20d?: number | null }>;
            regime?: { regime?: string };
          };
          if (raw.regime?.regime) regime = raw.regime.regime;
          const sigBy = new Map((raw.signals ?? []).map((s) => [s.symbol.toUpperCase(), s] as const));
          const intentBy = new Map(
            (raw.orders ?? [])
              .filter((o) => o.symbol)
              .map((o) => [`${(o.symbol ?? "").toUpperCase()}|${o.side ?? ""}`, o] as const),
          );
          for (const ex of raw.executed ?? []) {
            const sym = (ex.symbol ?? "").toUpperCase();
            if (!sym) continue;
            const side = (ex.side === "sell" ? "sell" : "buy") as "buy" | "sell";
            const intent = intentBy.get(`${sym}|${side}`);
            const sig = sigBy.get(sym);
            rows.push({
              date: d.run_date as string,
              symbol: sym,
              side,
              intent_pct: intent?.percent ?? null,
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
            });
          }
        }
        return { portfolio_id: p.id, name: p.name, risk_level: p.risk_level, rows, regime };
      }),
    );

    // Build (date, symbol) grid
    type Cell = Row | null;
    const grid = new Map<string, { date: string; symbol: string; cells: Cell[] }>();
    perP.forEach((pp, idx) => {
      for (const r of pp.rows) {
        const key = `${r.date}|${r.symbol}`;
        let entry = grid.get(key);
        if (!entry) {
          entry = { date: r.date, symbol: r.symbol, cells: perP.map(() => null) };
          grid.set(key, entry);
        }
        entry.cells[idx] = r;
      }
    });

    // Score divergence: number of distinct actions × total capital involved
    const scored = [...grid.values()]
      .map((g) => {
        const actions = g.cells.map((c) => (!c ? "none" : c.rejected ? "blocked" : c.side));
        const distinct = new Set(actions).size;
        if (distinct < 2) return null;
        const capital = g.cells.reduce((s, c) => s + (c?.executed_value ?? 0), 0);
        const score = (distinct - 1) * 100 + capital / 100;
        return { ...g, actions, score };
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => b.score - a.score)
      .slice(0, data.limit);

    if (scored.length === 0) return { events: [] };

    // Build compact JSON for the model
    const eventsForAi = scored.map((g) => ({
      date: g.date,
      symbol: g.symbol,
      portfolios: g.cells.map((c, i) => ({
        name: perP[i].name,
        risk_level: perP[i].risk_level,
        regime: perP[i].regime,
        action: !c ? "no action" : c.rejected ? "blocked" : c.side,
        rejected: c?.rejected ?? null,
        reason: c?.reason ?? null,
        intent_pct: c?.intent_pct ?? null,
        executed_value: c?.executed_value ?? 0,
        price: c?.price ?? null,
        signals: c?.signals ?? null,
        top_weights: c?.signal_weights
          ? Object.entries(c.signal_weights)
              .sort((a, b) => Number(b[1]) - Number(a[1]))
              .slice(0, 3)
              .map(([k, v]) => ({ signal: k, weight: Number(v) }))
          : [],
      })),
    }));

    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY missing");
    const { createLovableAiGatewayProvider } = await import("./ai-gateway.server");
    const { generateText, Output } = await import("ai");
    const gateway = createLovableAiGatewayProvider(key);
    const model = gateway("google/gemini-3.6-flash");

    const system = `You are Aegis, explaining trade divergences between paper portfolios in plain English to a non-technical investor.

For each event you are given: the date, symbol, and each portfolio's action (buy/sell/blocked/no action), the reason, risk level, macro regime, technical signals (RSI, SMA20/50, 5d/30d change, 20d volatility) and the top signal-importance weights.

For EACH event, write a short narrative (3-5 sentences) that:
1. States clearly what each portfolio did differently, referencing them by name.
2. Explains WHY they diverged — connect the difference to the priors (risk level, macro regime), the signals, and the signal-importance weights. Name specific numbers where they matter (e.g. "RSI at 24 flagged oversold", "SMA20 crossed below SMA50").
3. If a portfolio was blocked, explain which guardrail rejected it in plain English (e.g. cash floor, per-symbol cap, asset-class limit).
4. Ends with a one-line takeaway about what this divergence reveals about the strategies.

Avoid jargon dumps. Do not repeat the raw JSON. Do not give investment advice.`;

    let narratives: { date: string; symbol: string; narrative: string }[] = [];
    try {
      const { output } = await generateText({
        model,
        system,
        prompt: `Write narratives for these ${eventsForAi.length} divergence events:\n\n${JSON.stringify(eventsForAi, null, 2)}`,
        output: Output.object({
          schema: z.object({
            events: z
              .array(
                z.object({
                  date: z.string(),
                  symbol: z.string(),
                  narrative: z.string(),
                }),
              )
              .min(1),
          }),
        }),
      });
      narratives = output.events;
    } catch (err) {
      throw new Error(
        err instanceof Error
          ? `AI narrative generation failed: ${err.message}`
          : "AI narrative generation failed",
      );
    }

    // Zip narratives back to structured events
    const narrByKey = new Map(narratives.map((n) => [`${n.date}|${n.symbol}`, n.narrative]));
    const events = scored.map((g, idx) => ({
      rank: idx + 1,
      date: g.date,
      symbol: g.symbol,
      score: g.score,
      narrative: narrByKey.get(`${g.date}|${g.symbol}`) ?? "",
      portfolios: eventsForAi[idx].portfolios,
    }));
    return { events };
  });

export const getPortfolioLearning = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({ portfolio_id: z.string().uuid() }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: owned } = await context.supabase
      .from("portfolios")
      .select("id, last_run_date")
      .eq("id", data.portfolio_id)
      .single();
    if (!owned) throw new Error("Portfolio not found");
    const asOf = owned.last_run_date ?? new Date().toISOString().slice(0, 10);
    const { buildLearningContext } = await import("./learning.server");
    const ctx = await buildLearningContext(data.portfolio_id, asOf);
    return { as_of: asOf, ...ctx };
  });

export const getBenchmarkSeries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      symbol: z.string().min(1).max(12),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).parse(i),
  )
  .handler(async ({ data }) => {
    const { getDailyCandlesRange } = await import("./market-data.server");
    try {
      const candles = await getDailyCandlesRange(data.symbol, data.from, data.to);
      return {
        symbol: data.symbol,
        series: candles.map((c) => ({ date: c.date, close: Number(c.close) })),
      };
    } catch (err) {
      return { symbol: data.symbol, series: [] as { date: string; close: number }[], error: err instanceof Error ? err.message : "failed" };
    }
  });

// ============================================================================
// #12 — Portfolio optimizer: equal-weight, inverse-vol (risk parity),
// and max-Sharpe (mean-variance, long-only) target allocations.
// ============================================================================

function invertMatrix(m: number[][]): number[][] | null {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let i = 0; i < n; i++) {
    // pivot
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(a[r][i]) > Math.abs(a[pivot][i])) pivot = r;
    if (Math.abs(a[pivot][i]) < 1e-12) return null;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const div = a[i][i];
    for (let c = 0; c < 2 * n; c++) a[i][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = a[r][i];
      if (f === 0) continue;
      for (let c = 0; c < 2 * n; c++) a[r][c] -= f * a[i][c];
    }
  }
  return a.map((row) => row.slice(n));
}

function dailyReturnsFromCloses(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) out.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return out;
}

function meanOf(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function normaliseWeights(w: number[]): number[] {
  const clipped = w.map((x) => (x > 0 ? x : 0));
  const s = clipped.reduce((a, b) => a + b, 0);
  if (s <= 0) return w.map(() => 1 / w.length);
  return clipped.map((x) => x / s);
}

export const runPortfolioOptimizer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({
      portfolio_id: z.string().uuid(),
      extra_symbols: z.array(z.string().min(1).max(12)).max(20).default([]),
      lookback_days: z.number().int().min(30).max(504).default(126),
      max_weight_pct: z.number().min(5).max(100).default(35),
    }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const { data: portfolio, error: pErr } = await context.supabase
      .from("portfolios")
      .select("id,name,currency,starting_cash,risk_level,current_cash")
      .eq("id", data.portfolio_id)
      .single();
    if (pErr || !portfolio) throw new Error(pErr?.message ?? "Portfolio not found");

    const { data: holdings } = await context.supabase
      .from("holdings")
      .select("symbol, quantity, avg_cost")
      .eq("portfolio_id", data.portfolio_id);

    const heldSymbols = (holdings ?? []).map((h) => String(h.symbol).toUpperCase());
    const universe = Array.from(
      new Set([...heldSymbols, ...data.extra_symbols.map((s) => s.toUpperCase())]),
    );

    if (universe.length < 2) {
      return {
        portfolio: { id: portfolio.id, name: portfolio.name, currency: portfolio.currency },
        universe: [],
        stats: [] as Array<{ symbol: string; mean_ann_pct: number; vol_ann_pct: number; sharpe: number; last_close: number }>,
        current: [] as Array<{ symbol: string; weight_pct: number; value: number }>,
        weights: {
          equal: [] as Array<{ symbol: string; weight_pct: number }>,
          risk_parity: [] as Array<{ symbol: string; weight_pct: number }>,
          max_sharpe: [] as Array<{ symbol: string; weight_pct: number }>,
        },
        rebalance: {
          risk_parity: [] as Array<{ symbol: string; delta_pct: number; delta_value: number }>,
          max_sharpe: [] as Array<{ symbol: string; delta_pct: number; delta_value: number }>,
        },
        total_value: Number(portfolio.current_cash ?? portfolio.starting_cash ?? 0),
        cash: Number(portfolio.current_cash ?? 0),
        empty: true,
        message: "Need at least 2 symbols (current holdings + extras) to optimise.",
      };
    }

    // Fetch price series
    const { getDailyCandles } = await import("./market-data.server");
    const seriesBySym = new Map<string, number[]>();
    const lastCloseBySym = new Map<string, number>();
    await Promise.all(
      universe.map(async (s) => {
        try {
          const candles = await getDailyCandles(s, data.lookback_days + 5);
          if (candles.length >= 30) {
            seriesBySym.set(s, candles.map((c) => Number(c.close)));
            lastCloseBySym.set(s, Number(candles[candles.length - 1].close));
          }
        } catch {
          /* skip */
        }
      }),
    );

    const validSymbols = universe.filter((s) => seriesBySym.has(s));
    if (validSymbols.length < 2) {
      throw new Error("Not enough price data to optimise — need ≥ 30 trading days for at least 2 symbols.");
    }

    // Align returns to shortest length
    const returnsBySym = new Map<string, number[]>();
    let minLen = Infinity;
    for (const s of validSymbols) {
      const r = dailyReturnsFromCloses(seriesBySym.get(s)!);
      returnsBySym.set(s, r);
      minLen = Math.min(minLen, r.length);
    }
    for (const s of validSymbols) {
      const r = returnsBySym.get(s)!;
      returnsBySym.set(s, r.slice(r.length - minLen));
    }

    const n = validSymbols.length;
    const means = validSymbols.map((s) => meanOf(returnsBySym.get(s)!));
    // Covariance matrix (population, using deviations from mean)
    const cov: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        const ri = returnsBySym.get(validSymbols[i])!;
        const rj = returnsBySym.get(validSymbols[j])!;
        let s = 0;
        for (let k = 0; k < minLen; k++) s += (ri[k] - means[i]) * (rj[k] - means[j]);
        const v = s / Math.max(1, minLen - 1);
        cov[i][j] = v;
        cov[j][i] = v;
      }
    }
    // Ridge for numerical stability
    for (let i = 0; i < n; i++) cov[i][i] += 1e-6;

    const vols = cov.map((row, i) => Math.sqrt(row[i]));

    const stats = validSymbols.map((s, i) => ({
      symbol: s,
      mean_ann_pct: Number((means[i] * 252 * 100).toFixed(2)),
      vol_ann_pct: Number((vols[i] * Math.sqrt(252) * 100).toFixed(2)),
      sharpe: vols[i] > 0 ? Number(((means[i] / vols[i]) * Math.sqrt(252)).toFixed(2)) : 0,
      last_close: lastCloseBySym.get(s) ?? 0,
    }));

    // Current weights (need total value)
    const heldByS = new Map<string, { qty: number; last: number }>();
    for (const h of holdings ?? []) {
      const sym = String(h.symbol).toUpperCase();
      const last = lastCloseBySym.get(sym) ?? 0;
      heldByS.set(sym, { qty: Number(h.quantity), last });
    }
    const heldValue = Array.from(heldByS.values()).reduce((a, b) => a + b.qty * b.last, 0);
    const cash = Number(portfolio.current_cash ?? 0);
    const totalValue = heldValue + cash;
    const investable = totalValue; // full rebalance target
    const current = validSymbols.map((s) => {
      const h = heldByS.get(s);
      const value = h ? h.qty * h.last : 0;
      return {
        symbol: s,
        value: Number(value.toFixed(2)),
        weight_pct: totalValue > 0 ? Number(((value / totalValue) * 100).toFixed(2)) : 0,
      };
    });

    const cap = data.max_weight_pct / 100;
    const applyCap = (w: number[]): number[] => {
      // Iterative cap: clip to cap and redistribute residual to uncapped names
      let weights = [...w];
      for (let iter = 0; iter < 10; iter++) {
        let over = 0;
        const under: number[] = [];
        for (let i = 0; i < weights.length; i++) {
          if (weights[i] > cap) {
            over += weights[i] - cap;
            weights[i] = cap;
          } else {
            under.push(i);
          }
        }
        if (over < 1e-9 || under.length === 0) break;
        const underSum = under.reduce((a, i) => a + weights[i], 0);
        if (underSum <= 0) break;
        for (const i of under) weights[i] += over * (weights[i] / underSum);
      }
      return normaliseWeights(weights);
    };

    // Equal weight
    const equalW = validSymbols.map(() => 1 / n);

    // Inverse-vol (risk parity approximation)
    const invVol = vols.map((v) => (v > 0 ? 1 / v : 0));
    const rpW = normaliseWeights(invVol);
    const rpCapped = applyCap(rpW);

    // Max-Sharpe: unconstrained tangency w ∝ C^-1 μ, then long-only + cap
    let msRaw: number[] | null = null;
    const inv = invertMatrix(cov);
    if (inv) {
      msRaw = inv.map((row) => row.reduce((sum, v, j) => sum + v * means[j], 0));
    }
    let msW: number[];
    if (msRaw && msRaw.some((x) => x > 0)) {
      msW = normaliseWeights(msRaw);
    } else {
      // fallback: mean / variance normalized
      const fb = means.map((m, i) => (m > 0 ? m / Math.max(1e-6, cov[i][i]) : 0));
      msW = normaliseWeights(fb);
    }
    const msCapped = applyCap(msW);

    const toPct = (arr: number[]) =>
      validSymbols.map((s, i) => ({ symbol: s, weight_pct: Number((arr[i] * 100).toFixed(2)) }));

    const rebalanceFor = (targetW: number[]) =>
      validSymbols.map((s, i) => {
        const targetValue = investable * targetW[i];
        const currentValue = heldByS.get(s) ? heldByS.get(s)!.qty * heldByS.get(s)!.last : 0;
        const deltaVal = targetValue - currentValue;
        return {
          symbol: s,
          delta_pct: Number(((targetW[i] * 100) - (current.find((c) => c.symbol === s)?.weight_pct ?? 0)).toFixed(2)),
          delta_value: Number(deltaVal.toFixed(2)),
        };
      });

    return {
      portfolio: { id: portfolio.id, name: portfolio.name, currency: portfolio.currency },
      universe: validSymbols,
      stats,
      current,
      weights: {
        equal: toPct(equalW),
        risk_parity: toPct(rpCapped),
        max_sharpe: toPct(msCapped),
      },
      rebalance: {
        risk_parity: rebalanceFor(rpCapped),
        max_sharpe: rebalanceFor(msCapped),
      },
      total_value: Number(totalValue.toFixed(2)),
      cash: Number(cash.toFixed(2)),
      lookback_days: data.lookback_days,
      max_weight_pct: data.max_weight_pct,
      empty: false,
    };
  });

// ---------------------------------------------------------------------------
// Global news reel — recent world-events headlines plus a note explaining how
// the AI used each one in its recent decisions.
// ---------------------------------------------------------------------------

type NewsReelInfluence = {
  decision_id: string;
  portfolio_id: string;
  portfolio_name: string;
  run_date: string;
  sentiment: number | null;
  source_weight: number | null;
  impact: number | null;
  impact_pct: number | null;
  rationale: string | null;
  actions: Array<{ action: string; symbol: string; qty?: number | null }>;
};

type NewsReelItem = {
  id: string;
  date: string;
  source: string | null;
  headline: string;
  url: string | null;
  avg_sentiment: number | null;
  decisions_count: number;
  influences: NewsReelInfluence[];
  note: string;
  excerpt: string | null;
  asset_classes: string[];
  risk_levels: string[];
  symbols: string[];
};

// Trim a source summary to a short quotable citation snippet.
function toExcerpt(raw: string | null | undefined, maxChars = 240): string | null {
  if (!raw) return null;
  const cleaned = String(raw).replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (cleaned.length <= maxChars) return cleaned;
  const slice = cleaned.slice(0, maxChars);
  const lastStop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("? "), slice.lastIndexOf("! "));
  const cut = lastStop > 120 ? lastStop + 1 : slice.lastIndexOf(" ");
  return (cut > 80 ? slice.slice(0, cut) : slice).trim() + "…";
}

export const getGlobalNewsReel = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ items: NewsReelItem[]; as_of: string }> => {
    const asOf = new Date();
    const since = new Date(asOf.getTime() - 5 * 86_400_000).toISOString().slice(0, 10);

    // 1. Recent global news (auth-readable cache).
    const { data: newsRows } = await context.supabase
      .from("news_cache")
      .select("id, news_date, source, headline, url, summary")
      .gte("news_date", since)
      .order("news_date", { ascending: false })
      .order("fetched_at", { ascending: false })
      .limit(60);
    const news = newsRows ?? [];
    if (news.length === 0) return { items: [], as_of: asOf.toISOString() };

    // 2. Recent decisions across the user's own portfolios.
    const { data: portfolios } = await context.supabase
      .from("portfolios")
      .select("id, name, universe, risk_level");
    const pMap = new Map(
      (portfolios ?? []).map((p) => [
        p.id,
        {
          name: p.name,
          universe: (Array.isArray(p.universe) ? p.universe : []) as string[],
          risk_level: (p.risk_level ?? "balanced") as string,
        },
      ]),
    );
    const { data: decisions } = await context.supabase
      .from("decisions")
      .select("id, portfolio_id, run_date, rationale, raw")
      .gte("run_date", since)
      .order("run_date", { ascending: false })
      .limit(120);

    // 3. Build headline -> influences lookup.
    const infl = new Map<
      string,
      {
        sum: number;
        n: number;
        rows: NewsReelInfluence[];
        assetClasses: Set<string>;
        riskLevels: Set<string>;
        symbols: Set<string>;
      }
    >();
    for (const d of decisions ?? []) {
      const p = pMap.get(d.portfolio_id);
      const name = p?.name ?? "Portfolio";
      const raw = (d.raw ?? {}) as {
        news?: Array<{ headline?: string; sentiment?: number | null; source_weight?: number | null }>;
        executed?: Array<{ action?: string; symbol?: string; qty?: number | null }>;
        orders?: Array<{ action?: string; symbol?: string; qty?: number | null }>;
      };
      const usedNews = raw.news ?? [];
      if (usedNews.length === 0) continue;
      const acts = (raw.executed && raw.executed.length > 0 ? raw.executed : raw.orders) ?? [];
      const trimmed = acts
        .filter((a) => a && a.action && a.symbol && a.action !== "HOLD")
        .slice(0, 4)
        .map((a) => ({ action: String(a.action), symbol: String(a.symbol), qty: a.qty ?? null }));

      // Pre-compute per-decision impact = |sentiment| * source_weight, and total for normalization.
      const impacts = usedNews.map((n) => {
        const s = typeof n.sentiment === "number" ? Math.abs(n.sentiment) : 0;
        const w = typeof n.source_weight === "number" ? Math.max(0, n.source_weight) : 0.4;
        return s * w;
      });
      const impactTotal = impacts.reduce((a, b) => a + b, 0);

      for (let i = 0; i < usedNews.length; i++) {
        const n = usedNews[i];
        const head = (n.headline ?? "").trim();
        if (!head) continue;
        const bucket = infl.get(head) ?? {
          sum: 0, n: 0, rows: [],
          assetClasses: new Set<string>(), riskLevels: new Set<string>(), symbols: new Set<string>(),
        };
        if (typeof n.sentiment === "number") { bucket.sum += n.sentiment; bucket.n += 1; }
        const impact = impacts[i];
        const impactPct = impactTotal > 0 ? (impact / impactTotal) * 100 : null;
        bucket.rows.push({
          decision_id: d.id,
          portfolio_id: d.portfolio_id,
          portfolio_name: name,
          run_date: d.run_date,
          sentiment: typeof n.sentiment === "number" ? n.sentiment : null,
          source_weight: typeof n.source_weight === "number" ? n.source_weight : null,
          impact: Number.isFinite(impact) ? Number(impact.toFixed(3)) : null,
          impact_pct: impactPct != null ? Number(impactPct.toFixed(1)) : null,
          rationale: (d.rationale ?? null) as string | null,
          actions: trimmed,
        });
        if (p) {
          for (const c of p.universe) bucket.assetClasses.add(c);
          bucket.riskLevels.add(p.risk_level);
        }
        for (const a of trimmed) bucket.symbols.add(a.symbol);
        infl.set(head, bucket);
      }
    }

    // 4. Assemble reel items with a plain-English note per headline.
    const items: NewsReelItem[] = news.map((r) => {
      const bucket = infl.get(r.headline.trim());
      const rows = bucket?.rows ?? [];
      const avg = bucket && bucket.n > 0 ? bucket.sum / bucket.n : null;
      let note: string;
      if (rows.length === 0) {
        note = "Logged in the AI's briefing pool; no active decision has cited it yet.";
      } else {
        const tone = avg == null ? "neutral" : avg > 0.15 ? "bullish" : avg < -0.15 ? "bearish" : "neutral";
        const acts = rows.flatMap((x) => x.actions);
        const actSummary = acts.length === 0
          ? "reinforced a HOLD across affected positions"
          : Array.from(new Set(acts.map((a) => `${a.action} ${a.symbol}`))).slice(0, 3).join(", ");
        const portfolioNames = Array.from(new Set(rows.map((r) => r.portfolio_name))).slice(0, 3).join(", ");
        note = `Scored ${tone}${avg != null ? ` (${avg >= 0 ? "+" : ""}${avg.toFixed(2)})` : ""} and fed into ${rows.length} decision${rows.length === 1 ? "" : "s"} on ${portfolioNames} — ${actSummary}.`;
      }
      return {
        id: r.id,
        date: r.news_date,
        source: r.source,
        headline: r.headline,
        url: r.url,
        avg_sentiment: avg,
        decisions_count: rows.length,
        influences: rows.slice(0, 6),
        note,
        excerpt: toExcerpt((r as { summary?: string | null }).summary),
        asset_classes: bucket ? Array.from(bucket.assetClasses).sort() : [],
        risk_levels: bucket ? Array.from(bucket.riskLevels).sort() : [],
        symbols: bucket ? Array.from(bucket.symbols).sort() : [],
      };
    });

    // Sort: cited items first, then newest.
    items.sort((a, b) => {
      if ((b.decisions_count > 0 ? 1 : 0) !== (a.decisions_count > 0 ? 1 : 0)) {
        return (b.decisions_count > 0 ? 1 : 0) - (a.decisions_count > 0 ? 1 : 0);
      }
      return a.date < b.date ? 1 : -1;
    });

    return { items: items.slice(0, 40), as_of: asOf.toISOString() };
  });

// ---------------------------------------------------------------------------
// Decision -> news breakdown: maps each recent decision to the top news items
// that most influenced it (ranked by |sentiment|).
// ---------------------------------------------------------------------------

type DecisionNewsItem = {
  headline: string;
  source: string | null;
  url: string | null;
  sentiment: number | null;
};

type DecisionAction = { action: string; symbol: string; qty?: number | null };

type DecisionBreakdownItem = {
  decision_id: string;
  portfolio_id: string;
  portfolio_name: string;
  run_date: string;
  rationale: string | null;
  actions: DecisionAction[];
  top_news: DecisionNewsItem[];
  total_news_considered: number;
};

export const getDecisionNewsBreakdown = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ items: DecisionBreakdownItem[]; as_of: string }> => {
    const asOf = new Date();
    const since = new Date(asOf.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);

    const { data: portfolios } = await context.supabase
      .from("portfolios")
      .select("id, name");
    const pMap = new Map((portfolios ?? []).map((p) => [p.id, p.name]));

    const { data: decisions } = await context.supabase
      .from("decisions")
      .select("id, portfolio_id, run_date, rationale, raw")
      .gte("run_date", since)
      .order("run_date", { ascending: false })
      .limit(30);

    const items: DecisionBreakdownItem[] = (decisions ?? []).map((d) => {
      const raw = (d.raw ?? {}) as {
        news?: Array<{ headline?: string; source?: string | null; url?: string | null; sentiment?: number | null }>;
        executed?: Array<{ action?: string; symbol?: string; qty?: number | null }>;
        orders?: Array<{ action?: string; symbol?: string; qty?: number | null }>;
      };
      const news = (raw.news ?? []).filter((n) => (n.headline ?? "").trim().length > 0);
      const ranked = [...news].sort((a, b) => {
        const av = typeof a.sentiment === "number" ? Math.abs(a.sentiment) : -1;
        const bv = typeof b.sentiment === "number" ? Math.abs(b.sentiment) : -1;
        return bv - av;
      });
      const top = ranked.slice(0, 5).map((n) => ({
        headline: String(n.headline),
        source: n.source ?? null,
        url: n.url ?? null,
        sentiment: typeof n.sentiment === "number" ? n.sentiment : null,
      }));
      const acts = (raw.executed && raw.executed.length > 0 ? raw.executed : raw.orders) ?? [];
      const actions = acts
        .filter((a) => a && a.action && a.symbol)
        .slice(0, 8)
        .map((a) => ({ action: String(a.action), symbol: String(a.symbol), qty: a.qty ?? null }));
      return {
        decision_id: d.id,
        portfolio_id: d.portfolio_id,
        portfolio_name: pMap.get(d.portfolio_id) ?? "Portfolio",
        run_date: d.run_date,
        rationale: d.rationale ?? null,
        actions,
        top_news: top,
        total_news_considered: news.length,
      };
    });

    return { items, as_of: asOf.toISOString() };
  });

// Manually trigger the full hourly cycle (news refresh, regime detection,
// price refresh, per-portfolio tick + routing). This mirrors the pg_cron
// call to /api/public/hooks/hourly-run by POSTing to that same endpoint
// with the server-side CRON_SECRET so all shared logic stays in one place.
export const triggerHourlyRunNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      throw new Error(
        "Manual trigger unavailable: CRON_SECRET is not configured on the server.",
      );
    }
    const { getRequest } = await import("@tanstack/react-start/server");
    const req = getRequest();
    const origin = new URL(req.url).origin;
    const url = `${origin}/api/public/hooks/hourly-run`;
    const started = Date.now();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": secret,
      },
      body: JSON.stringify({ manual: true, triggered_at: new Date().toISOString() }),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const obj = (parsed && typeof parsed === "object") ? (parsed as Record<string, unknown>) : {};
    if (!res.ok) {
      const errMsg = typeof obj.error === "string" ? obj.error : `Hourly run failed with status ${res.status}`;
      throw new Error(errMsg);
    }
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const arr = Array.isArray(obj.results) ? obj.results as Array<Record<string, unknown>> : [];
    const results = arr.map((r) => ({
      id: str(r.id) ?? "",
      mode: str(r.mode) ?? "",
      ok: r.ok === true,
      value: num(r.value),
      skipped: str(r.skipped),
      error: str(r.error),
    }));
    return {
      ok: true,
      duration_ms: Date.now() - started,
      hour_utc: str(obj.hour_utc),
      date: str(obj.date),
      news_headlines: num(obj.news_headlines),
      prices_refreshed: num(obj.prices_refreshed),
      symbols_watched: num(obj.symbols_watched),
      portfolios: num(obj.portfolios),
      skipped_paused: num(obj.skipped_paused),
      results,
    };
  });


