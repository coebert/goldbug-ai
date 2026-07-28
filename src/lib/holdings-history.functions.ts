import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { normalizeLseDisplayPriceToBase } from "@/lib/market-price-units";



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

    return list.map((h) => {
      const assetClass = (h as { asset_class?: string | null }).asset_class ?? null;
      // Normalise both `avg_cost` (broker-native) and cached closes into the
      // LSE base currency (GBP) so downstream weighting / P&L math never
      // mixes GBX-quoted stocks with GBP-quoted ETFs in the same total.
      const avg = normalizeLseDisplayPriceToBase(h.symbol, Number(h.avg_cost), assetClass);
      const openedAt = h.opened_at ?? null;
      const openedDate = openedAt ? openedAt.slice(0, 10) : null;
      const yahoo = resolve(h.symbol);
      const all = bySymbol.get(yahoo) ?? [];
      // Only plot closes on/after the purchase date so the sparkline trend
      // matches the "since purchase" %. Pre-purchase history is discarded to
      // avoid the visual contradiction of an upward-sloping chart next to a
      // negative % change (or vice versa).
      const postPurchase = openedDate
        ? all.filter((p) => (p.date as string) >= openedDate)
        : all;
      const postCloses = postPurchase.map((p) =>
        normalizeLseDisplayPriceToBase(h.symbol, Number(p.close), assetClass),
      );
      // Anchor the series at avg_cost so a fresh purchase (0-1 closes after
      // opened_at) still renders a meaningful two-point trend from cost →
      // latest close, and every subsequent point is measured relative to
      // the same baseline used for the % change.
      const closes = avg > 0 ? [avg, ...postCloses] : postCloses;
      const currentPrice = postCloses.length > 0
        ? postCloses[postCloses.length - 1]
        : (closes.length > 0 ? closes[closes.length - 1] : null);
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

