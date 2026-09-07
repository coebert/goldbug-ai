import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { buildSymbolCashFlow, type SymbolCashFlowFill } from "./symbol-cash-flow";
import { normalizeMarketPriceForTrading } from "./market-price-units";

export const getSymbolCashFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ portfolioId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const [portfolioResult, fillsResult, holdingsResult] = await Promise.all([
      db.from("portfolios").select("currency").eq("id", data.portfolioId).single(),
      db.from("live_fills")
        .select("symbol,side,quantity,fill_price,fee,fee_source,currency,filled_at")
        .eq("portfolio_id", data.portfolioId)
        .order("filled_at", { ascending: true })
        .limit(5000),
      db.from("holdings").select("symbol,quantity").eq("portfolio_id", data.portfolioId),
    ]);
    if (portfolioResult.error || !portfolioResult.data) {
      throw new Error(portfolioResult.error?.message ?? "Portfolio not found");
    }
    if (fillsResult.error) throw new Error(fillsResult.error.message);
    if (holdingsResult.error) throw new Error(holdingsResult.error.message);

    const currency = String(portfolioResult.data.currency ?? "GBP").toUpperCase();
    const heldSymbols = new Set(
      (holdingsResult.data ?? [])
        .filter((holding) => Math.abs(Number(holding.quantity ?? 0)) > 0)
        .map((holding) => String(holding.symbol ?? "")),
    );
    const { convertAmount } = await import("./fx.server");
    const fxRates = new Map<string, number>();
    const toBase = async (amount: number, fromCurrency: string) => {
      const from = String(fromCurrency || currency).toUpperCase();
      if (!Number.isFinite(amount) || amount === 0 || from === currency) return amount;
      let rate = fxRates.get(from);
      if (rate == null) {
        const converted = await convertAmount(1, from, currency);
        if (!Number.isFinite(converted.amount) || converted.amount <= 0) {
          throw new Error(`No reliable ${from}/${currency} rate is available`);
        }
        rate = converted.amount;
        fxRates.set(from, rate);
      }
      return amount * rate;
    };

    const fills: SymbolCashFlowFill[] = [];
    for (const row of fillsResult.data ?? []) {
      const quantity = Number(row.quantity ?? 0);
      const fillPrice = normalizeMarketPriceForTrading(
        String(row.symbol ?? ""),
        Number(row.fill_price ?? 0),
      );
      if (!(quantity > 0) || !(fillPrice > 0)) continue;
      const fillCurrency = String(row.currency ?? currency).toUpperCase();
      const notionalBase = await toBase(quantity * fillPrice, fillCurrency);
      fills.push({
        symbol: String(row.symbol ?? ""),
        side: String(row.side ?? "").toLowerCase() === "sell" ? "sell" : "buy",
        quantity,
        fillPriceBase: notionalBase / quantity,
        feeBase: await toBase(Math.abs(Number(row.fee ?? 0)), fillCurrency),
        feeSource: row.fee_source === "broker" ? "broker" : row.fee_source === "model" ? "model" : "none",
      });
    }

    const rows = buildSymbolCashFlow(fills, heldSymbols);
    return {
      currency,
      rows,
      totals: {
        buyCash: rows.reduce((sum, row) => sum + row.buyCash, 0),
        sellCash: rows.reduce((sum, row) => sum + row.sellCash, 0),
        fees: rows.reduce((sum, row) => sum + row.fees, 0),
        netCashUsed: rows.reduce((sum, row) => sum + row.netCashUsed, 0),
      },
    };
  });