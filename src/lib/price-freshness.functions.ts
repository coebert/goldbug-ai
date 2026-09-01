// Price freshness for a portfolio's holdings.
//
// A retired ticker (ETHE.DE, VBTC.L) 404s at the data feed forever, and the
// fetcher silently falls back to whatever close was last cached. That looked
// exactly like a quiet market, so the dashboard needs to be told which symbols
// are actually quoting and which are frozen.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { priceSymbolVariants, resolvePriceSymbol } from "@/lib/price-symbol";

export type SymbolFreshness = {
  symbol: string;
  /** Feed key actually used (retired tickers map to their live successor). */
  resolved: string;
  lastDate: string | null;
  ageDays: number | null;
  status: "ok" | "stale" | "unavailable";
};

/** Trading days a quote may lag before we call it stale (covers a long weekend). */
const STALE_DAYS = 4;

function businessDaysBetween(from: Date, to: Date): number {
  let days = 0;
  const cur = new Date(from.getTime());
  while (cur < to) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) days += 1;
  }
  return days;
}

export const getPriceFreshness = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        extraSymbols: z.array(z.string()).max(50).default([]),
      })
      .parse(i),
  )
  .handler(async ({ data, context }): Promise<SymbolFreshness[]> => {
    const { supabase } = context;

    const { data: holdings } = await supabase
      .from("holdings")
      .select("symbol, quantity")
      .eq("portfolio_id", data.portfolioId);

    const symbols = [
      ...new Set(
        [
          ...(holdings ?? []).filter((h) => Number(h.quantity) !== 0).map((h) => String(h.symbol)),
          ...data.extraSymbols,
        ].filter(Boolean),
      ),
    ];
    if (symbols.length === 0) return [];

    const keys = [...new Set(symbols.flatMap((s) => priceSymbolVariants(s)))];
    const { data: rows } = await supabase
      .from("price_cache")
      .select("symbol, price_date")
      .in("symbol", keys)
      .order("price_date", { ascending: false })
      .limit(2000);

    const latest = new Map<string, string>();
    for (const r of rows ?? []) {
      const k = String(r.symbol).toUpperCase();
      if (!latest.has(k)) latest.set(k, String(r.price_date));
    }

    const today = new Date();
    return symbols.map((symbol) => {
      const resolved = resolvePriceSymbol(symbol);
      const lastDate =
        priceSymbolVariants(symbol)
          .map((k) => latest.get(k))
          .filter(Boolean)
          .sort()
          .pop() ?? null;
      if (!lastDate) {
        return { symbol, resolved, lastDate: null, ageDays: null, status: "unavailable" as const };
      }
      const ageDays = businessDaysBetween(new Date(`${lastDate}T00:00:00Z`), today);
      return {
        symbol,
        resolved,
        lastDate,
        ageDays,
        status: ageDays > STALE_DAYS ? ("stale" as const) : ("ok" as const),
      };
    });
  });
