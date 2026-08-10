// Server function behind the breakout signal backtest panel.
//
// Loads daily candles for the portfolio's tradeable universe (plus current
// holdings) from `price_cache`, replays the breakout detector bar-by-bar and
// returns the confirmed-vs-failed scorecard across recent market regimes.
//
// Auth: requireSupabaseAuth. The portfolio row is read through the caller's
// RLS-scoped client first, so the admin client is only used afterwards for
// global reference data (price_cache), never to decide access.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  runBreakoutBacktest,
  type BacktestBar,
  type BreakoutBacktestReport,
  type SymbolBars,
} from "@/lib/breakout-backtest";

export type BreakoutBacktestResponse = Omit<BreakoutBacktestReport, "trades"> & {
  /** Most recent signals only — the full list can be thousands of rows. */
  recentTrades: BreakoutBacktestReport["trades"];
  totalTrades: number;
  skippedSymbols: string[];
};

export const MAX_BACKTEST_SYMBOLS = 24;

export const runBreakoutSignalBacktest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        /** Calendar days of history to replay. */
        lookbackDays: z.number().int().min(120).max(2000).default(730),
        horizonBars: z.number().int().min(1).max(60).default(10),
        stopAtr: z.number().min(0).max(10).default(2),
        targetAtr: z.number().min(0).max(20).default(3),
        costBps: z.number().min(0).max(500).default(20),
        symbols: z.array(z.string().min(1).max(24)).max(MAX_BACKTEST_SYMBOLS).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<BreakoutBacktestResponse> => {
    // 1. Ownership check via RLS.
    const { data: pf, error: pfErr } = await context.supabase
      .from("portfolios")
      .select("id")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (pfErr) throw new Error(pfErr.message);
    if (!pf) throw new Error("Portfolio not found");

    // 2. Symbol set: explicit request, else the portfolio's own holdings,
    //    else a broad liquid default so the report is never empty.
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
    if (symbols.length < 4) {
      symbols = Array.from(
        new Set([
          ...symbols,
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
        ]),
      );
    }
    symbols = symbols.slice(0, MAX_BACKTEST_SYMBOLS);

    const from = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - data.lookbackDays);
      return d.toISOString().slice(0, 10);
    })();

    // 3. Bulk candle load (global reference data ⇒ admin client).
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
      if (bars.length < 120) {
        skippedSymbols.push(symbol);
        continue;
      }
      series.push({ symbol, bars });
    }

    if (!series.length) {
      throw new Error("No symbol had enough daily history to backtest breakouts.");
    }

    const report = runBreakoutBacktest(series, {
      horizonBars: data.horizonBars,
      stopAtr: data.stopAtr,
      targetAtr: data.targetAtr,
      costBps: data.costBps,
    });

    const { trades, ...rest } = report;
    return {
      ...rest,
      recentTrades: trades.slice(-60).reverse(),
      totalTrades: trades.length,
      skippedSymbols,
    };
  });
