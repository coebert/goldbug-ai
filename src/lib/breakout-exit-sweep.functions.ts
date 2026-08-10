// Server function behind the breakout exit sweep panel.
//
// Holds the DETECTOR fixed and sweeps trade management instead: stop distance
// (1–3 ATR), profit target (2–5 ATR) and holding horizon. Answers "which exit
// combination maximises win rate and reduces drawdown?".
//
// Auth: requireSupabaseAuth; portfolio ownership is checked through the
// caller's RLS-scoped client before any admin-client reference read.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { BacktestBar, SymbolBars } from "@/lib/breakout-backtest";
import {
  DEFAULT_EXIT_SWEEP_GRID,
  runBreakoutExitSweep,
  type BreakoutExitSweepReport,
} from "@/lib/breakout-exit-sweep";

export type BreakoutExitSweepResponse = Omit<BreakoutExitSweepReport, "results"> & {
  /** Ranked rows, capped for transport. */
  topResults: BreakoutExitSweepReport["results"];
  totalRanked: number;
  skippedSymbols: string[];
};

const DEFAULT_SWEEP_SYMBOLS = [
  "SPY",
  "QQQ",
  "AAPL",
  "MSFT",
  "NVDA",
  "JPM",
  "XOM",
  "GLD",
  "TLT",
  "IWM",
];

export const runBreakoutExitParameterSweep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        lookbackDays: z.number().int().min(240).max(2000).default(900),
        costBps: z.number().min(0).max(500).default(20),
        horizonBars: z.array(z.number().int().min(1).max(60)).min(1).max(4).default([10]),
        minConfirmedTrades: z.number().int().min(5).max(500).default(25),
        symbols: z.array(z.string().min(1).max(24)).max(16).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<BreakoutExitSweepResponse> => {
    const { data: pf, error: pfErr } = await context.supabase
      .from("portfolios")
      .select("id")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (pfErr) throw new Error(pfErr.message);
    if (!pf) throw new Error("Portfolio not found");

    let symbols = data.symbols ?? [];
    if (!symbols.length) {
      const { data: holdings } = await context.supabase
        .from("holdings")
        .select("symbol")
        .eq("portfolio_id", data.portfolioId);
      symbols = Array.from(
        new Set((holdings ?? []).map((h) => String(h.symbol).split(":")[0]!.toUpperCase())),
      );
    }
    symbols = Array.from(new Set([...symbols, ...DEFAULT_SWEEP_SYMBOLS])).slice(0, 12);

    const from = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - data.lookbackDays);
      return d.toISOString().slice(0, 10);
    })();

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const series: SymbolBars[] = [];
    const skippedSymbols: string[] = [];
    for (const symbol of symbols) {
      const { data: rows, error } = await supabaseAdmin
        .from("price_cache")
        .select("price_date, high, low, close, volume")
        .eq("symbol", symbol)
        .gte("price_date", from)
        .order("price_date", { ascending: true });
      if (error) throw new Error(`price_cache read failed for ${symbol}: ${error.message}`);
      const bars: BacktestBar[] = (rows ?? [])
        .filter((r) => r.high != null && r.low != null && r.close != null)
        .map((r) => ({
          date: r.price_date as string,
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          volume: r.volume == null ? null : Number(r.volume),
        }));
      if (bars.length < 240) {
        skippedSymbols.push(symbol);
        continue;
      }
      series.push({ symbol, bars });
    }
    if (!series.length) {
      throw new Error("No symbol had enough daily history to sweep breakout exits.");
    }

    const report = runBreakoutExitSweep(series, {
      grid: { ...DEFAULT_EXIT_SWEEP_GRID, horizonBars: data.horizonBars },
      objective: { minConfirmedTrades: data.minConfirmedTrades },
      costBps: data.costBps,
    });

    const { results, ...rest } = report;
    return {
      ...rest,
      topResults: results.slice(0, 20),
      totalRanked: results.length,
      skippedSymbols,
    };
  });
