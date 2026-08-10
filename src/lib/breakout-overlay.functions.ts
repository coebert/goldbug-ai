// Server function behind the breakout overlay chart.
//
// Loads daily candles for ONE symbol from `price_cache` and returns the
// drawable overlay (channel band + signal geometry), plus the symbol list the
// picker offers (the portfolio's own holdings first).
//
// Auth: requireSupabaseAuth. Ownership is checked through the caller's
// RLS-scoped client before the admin client touches global reference data.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { buildBreakoutOverlay, windowOverlay, type BreakoutOverlay } from "@/lib/breakout-overlay";
import type { BacktestBar } from "@/lib/breakout-backtest";

export type BreakoutOverlayResponse = {
  overlay: BreakoutOverlay;
  /** Symbols the picker should offer, holdings first. */
  symbols: string[];
  barCount: number;
};

const DEFAULT_SYMBOLS = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "JPM", "XOM", "GLD", "TLT", "IWM"];

/** Holdings are broker-native (`AAPL:xnas`); price_cache is keyed on the root. */
function priceKey(symbol: string): string {
  return String(symbol).split(":")[0]!.toUpperCase();
}

export const getBreakoutOverlay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        symbol: z.string().min(1).max(24).optional(),
        /** Calendar days of history to load (warmup needs ~4 months). */
        lookbackDays: z.number().int().min(180).max(1500).default(540),
        /** Bars actually drawn — the rest is warmup for the detector. */
        visibleBars: z.number().int().min(40).max(400).default(180),
        horizonBars: z.number().int().min(1).max(60).default(10),
        stopAtr: z.number().min(0).max(10).default(2),
        targetAtr: z.number().min(0).max(20).default(3),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<BreakoutOverlayResponse> => {
    const { data: pf, error: pfErr } = await context.supabase
      .from("portfolios")
      .select("id")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (pfErr) throw new Error(pfErr.message);
    if (!pf) throw new Error("Portfolio not found");

    const { data: holdings } = await context.supabase
      .from("holdings")
      .select("symbol")
      .eq("portfolio_id", data.portfolioId);
    const held = Array.from(new Set((holdings ?? []).map((h) => priceKey(String(h.symbol)))));
    const symbols = Array.from(new Set([...held, ...DEFAULT_SYMBOLS]));

    const symbol = priceKey(data.symbol ?? symbols[0] ?? "SPY");

    const from = (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - data.lookbackDays);
      return d.toISOString().slice(0, 10);
    })();

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
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

    if (bars.length < 100) {
      throw new Error(`${symbol} has only ${bars.length} daily bars cached — not enough to draw a range.`);
    }

    const full = buildBreakoutOverlay(symbol, bars, {
      horizonBars: data.horizonBars,
      stopAtr: data.stopAtr,
      targetAtr: data.targetAtr,
    });

    return {
      overlay: windowOverlay(full, data.visibleBars),
      symbols,
      barCount: bars.length,
    };
  });
