// Fill `price_cache` with the broker's own historical daily bars.
//
// The backtest-vs-real comparison was only as honest as the tape it replayed.
// Yahoo closes are adjusted, delayed and are not the prints our orders filled
// against, so a slice of the "strategy vs reality" gap was really a feed gap.
// This pulls Saxo daily bars for every symbol the portfolio actually traded or
// holds, over the requested window, and caches them under both the
// broker-native symbol and the canonical price key the backtester reads.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type SymbolBackfillResult = {
  symbol: string;
  bars: number;
  firstDate: string | null;
  lastDate: string | null;
  source: "broker" | "unavailable";
  reason?: string;
};

export type BrokerHistoryBackfillResult = {
  from: string;
  to: string;
  symbols: SymbolBackfillResult[];
  barsWritten: number;
  covered: number;
  requested: number;
};

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const backfillBrokerHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        /** Optional explicit symbol list; defaults to everything traded/held. */
        symbols: z.array(z.string().min(1)).max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<BrokerHistoryBackfillResult> => {
    const { supabase } = context;

    let symbols = data.symbols?.map((s) => s.trim()).filter(Boolean) ?? [];
    if (symbols.length === 0) {
      const [{ data: holdings }, { data: trades }, { data: orders }] = await Promise.all([
        supabase.from("holdings").select("symbol").eq("portfolio_id", data.portfolioId),
        supabase
          .from("trades")
          .select("symbol")
          .eq("portfolio_id", data.portfolioId)
          .gte("trade_date", data.from)
          .limit(2000),
        supabase
          .from("live_orders")
          .select("symbol")
          .eq("portfolio_id", data.portfolioId)
          .limit(2000),
      ]);
      symbols = [
        ...new Set(
          [...(holdings ?? []), ...(trades ?? []), ...(orders ?? [])]
            .map((r) => String((r as { symbol: string }).symbol))
            .filter(Boolean),
        ),
      ];
    }

    const { isBrokerRoutable, fetchBrokerDailyBars } = await import(
      "@/lib/brokers/saxo-prices.server"
    );
    const { resolvePriceSymbol } = await import("@/lib/price-symbol");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const spanDays = Math.max(
      1,
      Math.round((Date.parse(data.to) - Date.parse(data.from)) / 86_400_000),
    );
    // Saxo returns trading sessions, so ask for the calendar span plus slack.
    const count = Math.min(4000, Math.max(30, Math.ceil(spanDays * 0.75) + 20));

    const out: SymbolBackfillResult[] = [];
    let barsWritten = 0;

    for (const symbol of symbols) {
      if (!isBrokerRoutable(symbol)) {
        out.push({
          symbol,
          bars: 0,
          firstDate: null,
          lastDate: null,
          source: "unavailable",
          reason: "not a broker-routable instrument (index or FX pseudo-pair)",
        });
        continue;
      }
      let bars: Awaited<ReturnType<typeof fetchBrokerDailyBars>> = null;
      try {
        bars = await fetchBrokerDailyBars(symbol, { count, to: data.to, portfolioId: data.portfolioId });
      } catch (err) {
        out.push({
          symbol,
          bars: 0,
          firstDate: null,
          lastDate: null,
          source: "unavailable",
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const inWindow = (bars ?? []).filter((b) => b.date >= data.from && b.date <= data.to);
      if (inWindow.length === 0) {
        out.push({
          symbol,
          bars: 0,
          firstDate: null,
          lastDate: null,
          source: "unavailable",
          reason: "broker returned no bars for this window",
        });
        continue;
      }

      // Cache under every spelling a reader may use: the broker-native symbol
      // the holdings table stores, and the canonical key the backtester reads.
      const keys = [...new Set([symbol, resolvePriceSymbol(symbol)])];
      for (const key of keys) {
        const rows = inWindow.map((b) => ({
          symbol: key,
          price_date: b.date,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
        }));
        for (let i = 0; i < rows.length; i += 500) {
          const { error } = await supabaseAdmin
            .from("price_cache")
            .upsert(rows.slice(i, i + 500), { onConflict: "symbol,price_date" });
          if (error) throw new Error(`price_cache write failed for ${key}: ${error.message}`);
        }
        barsWritten += rows.length;
      }

      const dates = inWindow.map((b) => b.date).sort();
      out.push({
        symbol,
        bars: inWindow.length,
        firstDate: dates[0] ?? null,
        lastDate: dates[dates.length - 1] ?? null,
        source: "broker",
      });
    }

    return {
      from: data.from,
      to: data.to,
      symbols: out,
      barsWritten,
      covered: out.filter((s) => s.source === "broker").length,
      requested: out.length,
    };
  });

/** Default window: the portfolio's own trading history, capped at 3 years. */
export function defaultBackfillWindow(startedAt?: string | null, now = new Date()) {
  const to = isoDay(now);
  const cap = new Date(now);
  cap.setUTCFullYear(cap.getUTCFullYear() - 3);
  const started = startedAt ? new Date(startedAt) : cap;
  const from = isoDay(started > cap ? started : cap);
  return { from, to };
}
