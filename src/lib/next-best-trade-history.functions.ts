/**
 * Server side of the Portfolio page's "suggestions and what they did" panel.
 *
 * Reads the logged next-best-trade suggestions, this account's own buy fills,
 * and the latest close per suggested name, then hands them to the pure scorer
 * in `next-best-trade-history.ts`.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  buildSuggestionHistory,
  type SuggestionFill,
  type SuggestionHistory,
  type SuggestionRecord,
} from "./next-best-trade-history";
import { normalizeMarketPriceForTrading } from "./market-price-units";
import { inferSaxoCurrency } from "./saxo-fees";

export type SuggestionHistoryPanel = SuggestionHistory & { currency: string };

export const getNextBestTradeHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({ portfolioId: z.string().uuid(), days: z.number().int().min(1).max(365).optional() })
      .parse(i),
  )
  .handler(async ({ data, context }): Promise<SuggestionHistoryPanel> => {
    const db = context.supabase;
    const days = data.days ?? 60;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const [portfolioRes, suggestionRes, fillRes] = await Promise.all([
      db.from("portfolios").select("currency").eq("id", data.portfolioId).single(),
      db
        .from("next_best_trade_suggestions")
        .select("*")
        .eq("portfolio_id", data.portfolioId)
        .gte("suggested_at", since)
        .order("suggested_at", { ascending: true }),
      db
        .from("live_fills")
        .select("symbol, side, quantity, fill_price, fee, currency, filled_at")
        .eq("portfolio_id", data.portfolioId)
        .gte("filled_at", since)
        .order("filled_at", { ascending: true }),
    ]);

    if (portfolioRes.error) throw new Error(portfolioRes.error.message);
    if (suggestionRes.error) throw new Error(suggestionRes.error.message);

    const currency = String(portfolioRes.data?.currency ?? "GBP").toUpperCase();
    const suggestionRows = suggestionRes.data ?? [];
    if (suggestionRows.length === 0) {
      return {
        currency,
        rows: [],
        summary: {
          suggestions: 0,
          bought: 0,
          skipped: 0,
          hitRatePct: null,
          expectedBase: 0,
          actualBase: 0,
          missedBase: 0,
        },
      };
    }

    const symbols = Array.from(new Set(suggestionRows.map((r) => String(r.symbol))));

    // Latest close per suggested name; a handful of rows each covers weekends.
    const priceMap: Record<string, number> = {};
    const { data: priceRows } = await db
      .from("price_cache")
      .select("symbol, close, price_date")
      .in("symbol", symbols)
      .order("price_date", { ascending: false })
      .limit(symbols.length * 8);
    for (const r of priceRows ?? []) {
      const sym = String(r.symbol);
      if (priceMap[sym] == null) {
        const px = normalizeMarketPriceForTrading(sym, Number(r.close));
        if (px > 0) priceMap[sym] = px;
      }
    }

    const { convertAmount } = await import("./fx.server");
    const fxCache = new Map<string, number>();
    const rateToBase = async (from: string): Promise<number> => {
      const code = from.toUpperCase();
      if (code === currency) return 1;
      const cached = fxCache.get(code);
      if (cached != null) return cached;
      const converted = await convertAmount(1, code, currency).catch(() => 1);
      const safe = Number.isFinite(converted) && converted > 0 ? converted : 1;
      fxCache.set(code, safe);
      return safe;
    };

    const suggestions: SuggestionRecord[] = [];
    for (const r of suggestionRows) {
      const symbol = String(r.symbol);
      const ccy = String(r.currency ?? inferSaxoCurrency(symbol)).toUpperCase();
      suggestions.push({
        id: String(r.id),
        symbol,
        name: r.name ?? null,
        currency: ccy,
        suggestedAt: String(r.suggested_at),
        conviction: Number(r.conviction ?? 0),
        price: Number(r.price ?? 0),
        quantity: Number(r.quantity ?? 0),
        ticketBase: Number(r.ticket_base ?? 0),
        costBase: Number(r.cost_base ?? 0),
        expectedProfitBase: Number(r.expected_profit_base ?? 0),
        netEdgeBps: Number(r.net_edge_bps ?? 0),
        recommended: r.recommended === true,
        blockedReason: r.blocked_reason ?? null,
        fxToBase: await rateToBase(ccy),
      });
    }

    const fills: SuggestionFill[] = [];
    for (const f of fillRes.data ?? []) {
      const symbol = String(f.symbol ?? "");
      const quantity = Number(f.quantity ?? 0);
      const price = normalizeMarketPriceForTrading(symbol, Number(f.fill_price ?? 0));
      if (!symbol || !(quantity > 0) || !(price > 0)) continue;
      const feeCcy = String(f.currency ?? currency).toUpperCase();
      const fee = Math.abs(Number(f.fee ?? 0)) || 0;
      fills.push({
        symbol,
        side: String(f.side).toLowerCase() === "sell" ? "sell" : "buy",
        quantity,
        price,
        feeBase: fee > 0 ? fee * (await rateToBase(feeCcy)) : 0,
        filledAt: String(f.filled_at),
      });
    }

    return { currency, ...buildSuggestionHistory(suggestions, fills, priceMap) };
  });
