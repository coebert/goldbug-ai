import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { engineSymbolKey, priceSymbolVariants } from "./price-symbol";
import { inferVenue } from "./market-hours";
import { marketIdentity } from "./signals-by-market";
import { buildGlobalCoverage, type CoverageFill, type CoverageOrder, type CoverageSuggestion, type GlobalCoverage } from "./global-coverage";
import { normalizeMarketPriceForTrading } from "./market-price-units";
import { roundMoney } from "./format-money";

export const getGlobalCoverage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ days: z.union([z.literal(30), z.literal(60), z.literal(90)]).default(60) }).parse(input ?? {}))
  .handler(async ({ data, context }): Promise<GlobalCoverage | null> => {
    const db = context.supabase;
    const { data: portfolios, error: portfolioError } = await db.from("portfolios").select("id, name, currency, mode, status").order("created_at", { ascending: true });
    if (portfolioError) throw new Error(portfolioError.message);
    const portfolio = (portfolios ?? []).find((row) => row.mode === "live_prod") ?? (portfolios ?? []).find((row) => row.status === "active") ?? portfolios?.[0];
    if (!portfolio) return null;
    const since = new Date(Date.now() - data.days * 86_400_000).toISOString();
    const [suggestionRes, orderRes, fillRes] = await Promise.all([
      db.from("next_best_trade_suggestions").select("*").eq("portfolio_id", portfolio.id).gte("suggested_at", since).order("suggested_at", { ascending: true }),
      db.from("live_orders").select("id, symbol, quantity, status, reject_reason, created_at").eq("portfolio_id", portfolio.id).eq("side", "buy").gte("created_at", since).order("created_at", { ascending: true }),
      db.from("live_fills").select("order_id, symbol, quantity, filled_at").eq("portfolio_id", portfolio.id).eq("side", "buy").gte("filled_at", since).order("filled_at", { ascending: true }),
    ]);
    if (suggestionRes.error) throw new Error(suggestionRes.error.message);
    if (orderRes.error) throw new Error(orderRes.error.message);
    if (fillRes.error) throw new Error(fillRes.error.message);
    const rawSuggestions = suggestionRes.data ?? [];
    const symbols = [...new Set(rawSuggestions.map((row) => String(row.symbol)))];
    const lookup = [...new Set(symbols.flatMap((symbol) => priceSymbolVariants(symbol)))];
    const { data: priceRows } = lookup.length ? await db.from("price_cache").select("symbol, close, price_date").in("symbol", lookup).order("price_date", { ascending: false }).limit(Math.max(100, lookup.length * 8)) : { data: [] };
    const pricesNow: Record<string, number> = {};
    const suggestionSymbol = new Map(symbols.map((symbol) => [engineSymbolKey(symbol), symbol]));
    for (const row of priceRows ?? []) {
      const symbol = suggestionSymbol.get(engineSymbolKey(String(row.symbol)));
      if (!symbol || pricesNow[symbol] != null) continue;
      pricesNow[symbol] = normalizeMarketPriceForTrading(String(row.symbol), Number(row.close));
    }
    const suggestions: CoverageSuggestion[] = rawSuggestions.map((row) => {
      const symbol = String(row.symbol);
      const identity = marketIdentity(inferVenue(symbol));
      return { id: String(row.id), symbol, name: row.name, market: identity.key, marketLabel: identity.label, suggestedAt: String(row.suggested_at), quantity: Number(row.quantity), conviction: Number(row.conviction), expectedEdgeBps: Number(row.net_edge_bps), expectedProfitBase: Number(row.expected_profit_base), suggestedPrice: Number(row.price), costBase: Number(row.cost_base), fxToBase: 1, recommended: row.recommended, blockedReason: row.blocked_reason };
    });
    const orders: CoverageOrder[] = (orderRes.data ?? []).map((row) => ({ id: String(row.id), symbol: suggestionSymbol.get(engineSymbolKey(String(row.symbol))) ?? String(row.symbol), quantity: Number(row.quantity), status: String(row.status), reason: row.reject_reason, createdAt: String(row.created_at) }));
    const fills: CoverageFill[] = (fillRes.data ?? []).map((row) => ({ orderId: String(row.order_id), symbol: suggestionSymbol.get(engineSymbolKey(String(row.symbol))) ?? String(row.symbol), quantity: Number(row.quantity), filledAt: String(row.filled_at) }));
    const built = buildGlobalCoverage({ suggestions, orders, fills, pricesNow, now: new Date() });
    const quantity = built.rows.reduce((sum, row) => sum + row.quantity, 0);
    const filledQuantity = built.rows.reduce((sum, row) => sum + row.filledQuantity, 0);
    return { portfolioId: String(portfolio.id), portfolioName: String(portfolio.name), currency: String(portfolio.currency ?? "GBP"), days: data.days, suggestions: built.rows.length, filled: built.rows.filter((row) => row.status === "filled" || row.status === "partial").length, missed: built.rows.filter((row) => row.status === "missed").length, pending: built.rows.filter((row) => row.status === "pending").length, fillRate: quantity > 0 ? Math.min(1, filledQuantity / quantity) : 0, missedProfitBase: roundMoney(built.rows.reduce((sum, row) => sum + (row.missedOutcomeBase ?? 0), 0)), groups: built.groups };
  });