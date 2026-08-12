import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveYahoo } from "@/lib/backfill-holdings-history.helpers";
import { normalizeLseDisplayPriceToBase } from "@/lib/market-price-units";
import {
  buildEquityComposition,
  type CompositionPrice,
  type EquityComposition,
} from "@/lib/equity-composition";

export type { EquityComposition };

export const getEquityComposition = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        sinceDays: z.number().int().min(7).max(1825).optional(),
      })
      .parse(raw),
  )
  .handler(async ({ data, context }): Promise<EquityComposition> => {
    const { supabase } = context;
    const days = data.sinceDays ?? 180;
    const sinceIso = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

    const [{ data: portfolio }, { data: snapshots }, { data: trades }] = await Promise.all([
      supabase.from("portfolios").select("currency").eq("id", data.portfolioId).maybeSingle(),
      supabase
        .from("equity_snapshots")
        .select("snapshot_date, cash, holdings_value, total_value")
        .eq("portfolio_id", data.portfolioId)
        .gte("snapshot_date", sinceIso)
        .order("snapshot_date", { ascending: true }),
      supabase
        .from("trades")
        .select("trade_date, symbol, side, quantity")
        .eq("portfolio_id", data.portfolioId)
        .order("trade_date", { ascending: true }),
    ]);

    const currency = String(portfolio?.currency ?? "GBP").toUpperCase();
    const snapRows = snapshots ?? [];
    const tradeRows = trades ?? [];
    if (snapRows.length === 0) return { symbols: [], rows: [], currency };

    const symbols = Array.from(new Set(tradeRows.map((t) => String(t.symbol))));
    const prices: Record<string, CompositionPrice[]> = {};
    if (symbols.length) {
      const lookup = Array.from(new Set(symbols.map((s) => resolveYahoo(s))));
      const { data: priceRows } = await supabase
        .from("price_cache")
        .select("symbol, price_date, close")
        .in("symbol", lookup)
        .gte("price_date", sinceIso)
        .order("price_date", { ascending: true });

      const byLookup = new Map<string, Array<{ date: string; close: number }>>();
      for (const p of priceRows ?? []) {
        const arr = byLookup.get(String(p.symbol)) ?? [];
        arr.push({ date: String(p.price_date), close: Number(p.close) });
        byLookup.set(String(p.symbol), arr);
      }
      for (const symbol of symbols) {
        const series = byLookup.get(resolveYahoo(symbol)) ?? [];
        prices[symbol] = series.map((p) => ({
          date: p.date,
          close: normalizeLseDisplayPriceToBase(symbol, p.close),
        }));
      }
    }

    return buildEquityComposition({
      snapshots: snapRows.map((s) => ({
        snapshot_date: String(s.snapshot_date),
        cash: s.cash,
        holdings_value: s.holdings_value,
        total_value: s.total_value,
      })),
      trades: tradeRows.map((t) => ({
        trade_date: String(t.trade_date),
        symbol: String(t.symbol),
        side: String(t.side),
        quantity: t.quantity,
      })),
      prices,
      currency,
    });
  });
