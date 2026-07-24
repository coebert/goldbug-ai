import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type HoldingSeries = {
  symbol: string;
  opened_at: string | null;
  avg_cost: number;
  quantity: number;
  closes: number[]; // ordered oldest -> newest
  currentPrice: number | null;
  pctChangeSincePurchase: number | null;
  valueChangeSincePurchase: number | null;
  points: number;
};

/**
 * For each holding in a portfolio, return a price series from `opened_at`
 * (bounded to ~180 days) through today, along with the % change of the asset
 * since its purchase price (avg_cost). Missing price history returns an empty
 * series and null deltas — the UI degrades gracefully.
 */
export const getHoldingsHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ portfolioId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }): Promise<HoldingSeries[]> => {
    const { data: holdings } = await context.supabase
      .from("holdings")
      .select("symbol, quantity, avg_cost, opened_at")
      .eq("portfolio_id", data.portfolioId);
    const list = (holdings ?? []).filter((h) => Number(h.quantity) > 0);
    if (list.length === 0) return [];

    // Earliest purchase across all holdings caps the price_cache scan.
    const now = new Date();
    const earliest = list.reduce<Date>((acc, h) => {
      const t = h.opened_at ? new Date(h.opened_at) : now;
      return t < acc ? t : acc;
    }, now);
    // Guard against absurd ranges — 2 years max, at least 30 days.
    const minSince = new Date(now.getTime() - 730 * 24 * 60 * 60 * 1000);
    const since = earliest < minSince ? minSince : earliest;
    const sinceIso = since.toISOString().slice(0, 10);

    const symbols = Array.from(new Set(list.map((h) => h.symbol)));
    const { data: prices } = await context.supabase
      .from("price_cache")
      .select("symbol, price_date, close")
      .in("symbol", symbols)
      .gte("price_date", sinceIso)
      .order("price_date", { ascending: true });

    const bySymbol = new Map<string, Array<{ date: string; close: number }>>();
    for (const p of prices ?? []) {
      const arr = bySymbol.get(p.symbol) ?? [];
      arr.push({ date: p.price_date as string, close: Number(p.close) });
      bySymbol.set(p.symbol, arr);
    }

    return list.map((h) => {
      const avg = Number(h.avg_cost);
      const openedAt = h.opened_at ?? null;
      const openedDate = openedAt ? openedAt.slice(0, 10) : sinceIso;
      const all = bySymbol.get(h.symbol) ?? [];
      const series = all.filter((p) => p.date >= openedDate);
      const closes = series.map((p) => p.close);
      const currentPrice = closes.length > 0 ? closes[closes.length - 1] : null;
      const pct =
        currentPrice != null && avg > 0 ? (currentPrice - avg) / avg : null;
      const valueChange =
        currentPrice != null ? (currentPrice - avg) * Number(h.quantity) : null;
      return {
        symbol: h.symbol,
        opened_at: openedAt,
        avg_cost: avg,
        quantity: Number(h.quantity),
        closes,
        currentPrice,
        pctChangeSincePurchase: pct,
        valueChangeSincePurchase: valueChange,
        points: closes.length,
      };
    });
  });
