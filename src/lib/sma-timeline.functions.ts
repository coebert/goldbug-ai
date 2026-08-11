import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { resolvePriceSymbol } from "@/lib/price-symbol";
import { normalizeLseDisplayPriceToBase } from "@/lib/market-price-units";
import { buildSmaSymbolReport, type SmaSymbolReport } from "@/lib/sma-timeline";
import { smaRulesForRisk, normalizeSmaRisk } from "@/lib/alpha/sma-risk-profiles";

/** Enough history for SMA200 plus a couple of years of crossover context. */
const MAX_BARS = 1200;

export type SmaReportResponse = {
  symbols: string[];
  report: SmaSymbolReport | null;
};

/**
 * Per-symbol SMA report: crossover points, golden/death regime timeline and
 * the buy/sell decisions actually taken, for one portfolio's traded symbols.
 *
 * Prices come from the shared daily cache and are normalised out of pence
 * before any SMA is computed, so LSE names line up with their GBP fills.
 */
export const getSmaSymbolReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({ portfolioId: z.string().uuid(), symbol: z.string().trim().min(1).optional() })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<SmaReportResponse> => {
    const { supabase } = context;

    const [{ data: portfolio }, { data: trades }, { data: holdings }] = await Promise.all([
      supabase.from("portfolios").select("id, risk_level").eq("id", data.portfolioId).maybeSingle(),
      supabase
        .from("trades")
        .select("symbol, side, quantity, price, value, trade_date, reason")
        .eq("portfolio_id", data.portfolioId)
        .order("trade_date", { ascending: true }),
      supabase.from("holdings").select("symbol").eq("portfolio_id", data.portfolioId),
    ]);

    const symbols = [
      ...new Set([
        ...(trades ?? []).map((t) => String(t.symbol)),
        ...(holdings ?? []).map((h) => String(h.symbol)),
      ]),
    ].sort();

    const symbol = data.symbol && symbols.includes(data.symbol) ? data.symbol : symbols[0];
    if (!symbol) return { symbols, report: null };

    const priceSymbol = resolvePriceSymbol(symbol).toUpperCase();
    const { data: prices } = await supabase
      .from("price_cache")
      .select("price_date, close")
      .eq("symbol", priceSymbol)
      .order("price_date", { ascending: false })
      .limit(MAX_BARS);

    const bars = (prices ?? [])
      .map((p) => ({
        date: String(p.price_date),
        close: normalizeLseDisplayPriceToBase(priceSymbol, Number(p.close)),
      }))
      .reverse();

    const decisions = (trades ?? [])
      .filter((t) => String(t.symbol) === symbol)
      .map((t) => ({
        date: String(t.trade_date),
        side: t.side as "buy" | "sell",
        quantity: Number(t.quantity),
        price: Number(t.price),
        value: Number(t.value),
        reason: t.reason ?? null,
      }));

    const rules = smaRulesForRisk(normalizeSmaRisk(portfolio?.risk_level ?? null));
    return { symbols, report: buildSmaSymbolReport(symbol, bars, decisions, rules) };
  });
