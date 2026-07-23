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
