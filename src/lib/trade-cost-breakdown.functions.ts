import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { buildTradeCostBreakdown, type TradeCostFill } from "./trade-cost-breakdown";
import { normalizeMarketPriceForTrading } from "./market-price-units";

export const getTradeCostBreakdown = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        limit: z.number().int().min(5).max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const [portfolioRes, fillsRes] = await Promise.all([
      db
        .from("portfolios")
        .select("currency,current_cash")
        .eq("id", data.portfolioId)
        .single(),
      db
        .from("live_fills")
        .select(
          "id,symbol,side,quantity,fill_price,fee,fee_commission,fee_tax,fee_exchange,fee_other,fee_source,currency,filled_at",
        )
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

    const fills: TradeCostFill[] = [];
    for (const row of fillsRes.data ?? []) {
      const symbol = String(row.symbol ?? "");
      const quantity = Number(row.quantity ?? 0);
      const price = normalizeMarketPriceForTrading(symbol, Number(row.fill_price ?? 0));
      if (!symbol || !(quantity > 0) || !(price > 0)) continue;
      const fx = await rateFor(String(row.currency ?? currency));
      const scale = (value: unknown): number | null => {
        const n = Number(value);
        return Number.isFinite(n) ? Math.abs(n) * fx : null;
      };
      fills.push({
        id: String(row.id),
        symbol,
        side: String(row.side ?? "").toLowerCase() === "sell" ? "sell" : "buy",
        quantity,
        priceBase: price * fx,
        feeBase: Math.abs(Number(row.fee ?? 0)) * fx,
        commissionBase: scale(row.fee_commission),
        taxBase: scale(row.fee_tax),
        exchangeBase: scale(row.fee_exchange),
        otherBase: scale(row.fee_other),
        feeSource:
          row.fee_source === "broker" ? "broker" : row.fee_source === "model" ? "model" : "none",
        filledAt: String(row.filled_at ?? ""),
      });
    }

    const cashNow = Number(portfolioRes.data.current_cash ?? 0);
    const breakdown = buildTradeCostBreakdown(fills, Number.isFinite(cashNow) ? cashNow : 0);
    const limit = data.limit ?? 30;
    return {
      currency,
      asOf: new Date().toISOString(),
      rows: breakdown.rows.slice(-limit).reverse(),
      summary: breakdown.summary,
    };
  });
