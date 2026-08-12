import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { normalizeLseDisplayPriceToBase } from "@/lib/market-price-units";
import { auditHoldingSeriesBatch, formatIssue } from "@/lib/holdings-series-sanity";
import { buildHoldingSeries } from "@/lib/build-holding-series";



export type HoldingSeries = {
  symbol: string;
  opened_at: string | null;
  avg_cost: number;
  quantity: number;
  closes: number[]; // ordered oldest -> newest
  hourly: number[]; // hour-bucketed prices, oldest -> newest
  hourlyAt: string[]; // ISO timestamps aligned with `hourly`
  currentPrice: number | null;
  pctChangeSincePurchase: number | null;
  valueChangeSincePurchase: number | null;
  points: number;
  /** Broker hourly quotes disagree with the latest close — ignore them. */
  hourlyStale: boolean;
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
      .select("symbol, quantity, avg_cost, opened_at, asset_class")
      .eq("portfolio_id", data.portfolioId);
    const list = (holdings ?? []).filter((h) => Number(h.quantity) > 0);

    if (list.length === 0) return [];

    // Holdings may store broker-native symbols (e.g. "VUKE:xlon") while the
    // price_cache is keyed by Yahoo-style tickers ("VUKE.L"). Map the MIC
    // suffix locally so LSE / XETR / US holdings all resolve to the right
    // price series without an extra round-trip.
    const MIC_TO_YAHOO: Record<string, string> = {
      xlon: "L", xetr: "DE", xpar: "PA", xams: "AS", xmil: "MI",
      xmad: "MC", xswx: "SW", xtse: "TO", xhkg: "HK", xtks: "T",
      xasx: "AX", xsto: "ST", xcse: "CO", xhel: "HE", xose: "OL",
      xnas: "", xnys: "", arcx: "", bats: "",
    };
    const resolve = (sym: string): string => {
      const colon = sym.lastIndexOf(":");
      if (colon < 0) return sym;
      const base = sym.slice(0, colon);
      const mic = sym.slice(colon + 1).toLowerCase();
      const yahoo = MIC_TO_YAHOO[mic];
      if (yahoo == null) return sym;
      return yahoo ? `${base}.${yahoo}` : base;
    };



    // Window: at least 30 days of context so a fresh purchase still renders a
    // sparkline on Day 1 (purchase point is highlighted by pct/value math
    // below, which stays anchored to avg_cost).
    const now = new Date();
    const earliest = list.reduce<Date>((acc, h) => {
      const t = h.opened_at ? new Date(h.opened_at) : now;
      return t < acc ? t : acc;
    }, now);
    const contextStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const minSince = new Date(now.getTime() - 730 * 24 * 60 * 60 * 1000);
    const rawSince = earliest < contextStart ? earliest : contextStart;
    const since = rawSince < minSince ? minSince : rawSince;
    const sinceIso = since.toISOString().slice(0, 10);

    const lookupSymbols = Array.from(new Set(list.map((h) => resolve(h.symbol))));
    const { data: prices } = await context.supabase
      .from("price_cache")
      .select("symbol, price_date, close")
      .in("symbol", lookupSymbols)
      .gte("price_date", sinceIso)
      .order("price_date", { ascending: true });

    const bySymbol = new Map<string, Array<{ date: string; close: number }>>();
    for (const p of prices ?? []) {
      const arr = bySymbol.get(p.symbol) ?? [];
      arr.push({ date: p.price_date as string, close: Number(p.close) });
      bySymbol.set(p.symbol, arr);
    }

    // Hourly observations recorded by the broker sync. Keyed by the raw
    // broker-native symbol (that's what the sync writes), so no MIC mapping
    // here. 14 days keeps the payload small while covering any recent buy.
    const intradaySince = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: intradayRows } = await context.supabase
      .from("price_intraday")
      .select("symbol, bucket_hour, price")
      .in("symbol", Array.from(new Set(list.map((h) => h.symbol))))
      .gte("bucket_hour", intradaySince)
      .order("bucket_hour", { ascending: true });

    const intradayBySymbol = new Map<string, Array<{ at: string; close: number }>>();
    for (const r of intradayRows ?? []) {
      const arr = intradayBySymbol.get(r.symbol) ?? [];
      arr.push({ at: String(r.bucket_hour), close: Number(r.price) });
      intradayBySymbol.set(r.symbol, arr);
    }

    const result = list.map((h) =>
      buildHoldingSeries(
        {
          symbol: h.symbol,
          quantity: h.quantity,
          avg_cost: h.avg_cost,
          opened_at: h.opened_at,
          asset_class: (h as { asset_class?: string | null }).asset_class ?? null,
        },
        bySymbol.get(resolve(h.symbol)) ?? [],
        intradayBySymbol.get(h.symbol) ?? [],
      ),
    );

    // Runtime sanity: catch sparkline ↔ headline % drift server-side before
    // the payload ever hits the UI. Log-only; never throws.
    const issues = auditHoldingSeriesBatch(
      result.map((r) => ({
        symbol: r.symbol,
        avg_cost: r.avg_cost,
        closes: r.closes,
        currentPrice: r.currentPrice,
        pctChangeSincePurchase: r.pctChangeSincePurchase,
        points: r.points,
      })),
    );
    for (const i of issues) console.warn(formatIssue(i));
    return result;
  });

