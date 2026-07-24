import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  buildHoldingsOverTime,
  tailEquity,
  type EquityRow,
  type HoldingsOverTime,
} from "./backtest-series";

const InputSchema = z.object({
  portfolio_id: z.string().uuid(),
  days: z.number().int().min(1).max(3650),
});

export type BacktestSeriesResult = {
  equity: EquityRow[];
  holdings: HoldingsOverTime;
  startingCash: number;
  from: string | null;
  to: string | null;
};

/**
 * Returns the equity curve and reconstructed holdings-over-time for the last
 * `days` snapshot dates of a portfolio. Used by the Backtest results card.
 */
export const getBacktestSeries = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data, context }): Promise<BacktestSeriesResult> => {
    const { data: pf } = await context.supabase
      .from("portfolios")
      .select("starting_cash")
      .eq("id", data.portfolio_id)
      .maybeSingle();
    const startingCash = Number(pf?.starting_cash ?? 0);

    const { data: eqRows } = await context.supabase
      .from("equity_snapshots")
      .select("snapshot_date,total_value")
      .eq("portfolio_id", data.portfolio_id)
      .order("snapshot_date", { ascending: true });

    const equityAll: EquityRow[] = (eqRows ?? []).map((r) => ({
      snapshot_date: r.snapshot_date as string,
      total_value: Number(r.total_value),
    }));
    const equity = tailEquity(equityAll, data.days);
    const from = equity[0]?.snapshot_date ?? null;
    const to = equity[equity.length - 1]?.snapshot_date ?? null;

    if (!from || !to) {
      return {
        equity,
        holdings: { symbols: [], points: [] },
        startingCash,
        from,
        to,
      };
    }

    const { data: tradeRows } = await context.supabase
      .from("trades")
      .select("trade_date,executed_at,side,symbol,quantity,price")
      .eq("portfolio_id", data.portfolio_id)
      .lte("trade_date", to)
      .order("trade_date", { ascending: true });

    const trades = (tradeRows ?? []).map((t) => ({
      trade_date: t.trade_date as string,
      executed_at: (t.executed_at as string | null) ?? null,
      side: t.side as "buy" | "sell",
      symbol: t.symbol as string,
      quantity: Number(t.quantity),
      price: Number(t.price),
    }));

    const symbols = Array.from(new Set(trades.map((t) => t.symbol)));
    const { data: priceRows } =
      symbols.length > 0
        ? await context.supabase
            .from("price_cache")
            .select("symbol,price_date,close")
            .in("symbol", symbols)
            .lte("price_date", to)
            .order("price_date", { ascending: true })
        : { data: [] as Array<{ symbol: string; price_date: string; close: number }> };

    const dates = equity.map((e) => e.snapshot_date);
    const holdings = buildHoldingsOverTime(
      trades,
      dates,
      (priceRows ?? []).map((p) => ({
        symbol: p.symbol as string,
        price_date: p.price_date as string,
        close: Number(p.close),
      })),
      startingCash,
    );

    return { equity, holdings, startingCash, from, to };
  });
