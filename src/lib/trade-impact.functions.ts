import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { buildTradeImpact, type TradeImpactFill } from "./trade-impact";
import { normalizeMarketPriceForTrading } from "./market-price-units";
import { engineSymbolKey } from "./price-symbol";

export const getTradeImpact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({ portfolioId: z.string().uuid(), limit: z.number().int().min(5).max(200).optional() })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const [portfolioRes, fillsRes] = await Promise.all([
      db.from("portfolios").select("currency").eq("id", data.portfolioId).single(),
      db
        .from("live_fills")
        .select("id,symbol,side,quantity,fill_price,fee,fee_source,currency,filled_at")
        .eq("portfolio_id", data.portfolioId)
        .order("filled_at", { ascending: true })
        .limit(5000),
    ]);
    if (portfolioRes.error || !portfolioRes.data) {
      throw new Error(portfolioRes.error?.message ?? "Portfolio not found");
    }
    if (fillsRes.error) throw new Error(fillsRes.error.message);

    const currency = String(portfolioRes.data.currency ?? "GBP").toUpperCase();
    const { convertAmount } = await import("./fx.server");
    const rates = new Map<string, number>();
    const rateFor = async (from: string): Promise<number> => {
      const code = String(from || currency).toUpperCase();
      if (code === currency) return 1;
      const cached = rates.get(code);
      if (cached != null) return cached;
      const converted = await convertAmount(1, code, currency).catch(() => ({ amount: NaN }));
      const rate = Number(converted.amount);
      const safe = Number.isFinite(rate) && rate > 0 ? rate : 1;
      rates.set(code, safe);
      return safe;
    };

    const fills: TradeImpactFill[] = [];
    for (const row of fillsRes.data ?? []) {
      const symbol = String(row.symbol ?? "");
      const quantity = Number(row.quantity ?? 0);
      const price = normalizeMarketPriceForTrading(symbol, Number(row.fill_price ?? 0));
      if (!symbol || !(quantity > 0) || !(price > 0)) continue;
      const fx = await rateFor(String(row.currency ?? currency));
      fills.push({
        id: String(row.id),
        symbol,
        side: String(row.side ?? "").toLowerCase() === "sell" ? "sell" : "buy",
        quantity,
        priceBase: price * fx,
        feeBase: Math.abs(Number(row.fee ?? 0)) * fx,
        feeSource:
          row.fee_source === "broker" ? "broker" : row.fee_source === "model" ? "model" : "none",
        filledAt: String(row.filled_at ?? ""),
      });
    }

    // Latest close per traded symbol, in account currency, to mark open lots.
    const symbols = [...new Set(fills.map((f) => f.symbol))];
    const marks = new Map<string, number>();
    if (symbols.length > 0) {
      const bases = [...new Set(symbols.map((s) => engineSymbolKey(s).split(":")[0] ?? s))];
      const priceRes = await db
        .from("price_cache")
        .select("symbol,close,price_date")
        .in("symbol", bases)
        .order("price_date", { ascending: false })
        .limit(2000);
      const latest = new Map<string, number>();
      for (const row of priceRes.data ?? []) {
        const key = String(row.symbol ?? "").toUpperCase();
        if (latest.has(key)) continue;
        const close = Number(row.close ?? 0);
        if (close > 0) latest.set(key, close);
      }
      const { inferSaxoCurrency } = await import("./saxo-fees");
      for (const symbol of symbols) {
        const base = (engineSymbolKey(symbol).split(":")[0] ?? symbol).toUpperCase();
        const close = latest.get(base);
        if (close == null) continue;
        const price = normalizeMarketPriceForTrading(symbol, close);
        if (!(price > 0)) continue;
        marks.set(symbol, price * (await rateFor(inferSaxoCurrency(symbol))));
      }
    }

    const impact = buildTradeImpact(fills, marks);
    const limit = data.limit ?? 30;
    return {
      currency,
      asOf: new Date().toISOString(),
      rows: impact.rows.slice(-limit).reverse(),
      open: impact.open,
      summary: impact.summary,
    };
  });
