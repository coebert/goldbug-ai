import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { computeFeeBreakdown, type FeeBreakdown, type FeeTradeInput } from "./fee-breakdown";

/**
 * Returns per-trade commission estimates and per-round-trip net returns for a
 * portfolio's trade history. Uses the same Saxo Classic fee schedule the
 * trading engine consults when deciding whether an order clears the fee guard.
 */
export const getFeeBreakdown = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolio_id: z.string().uuid(),
        days: z.number().int().min(1).max(3650).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<FeeBreakdown & { from: string | null; to: string | null }> => {
    const { data: pf } = await context.supabase
      .from("portfolios")
      .select("currency")
      .eq("id", data.portfolio_id)
      .maybeSingle();
    const displayCurrency = (pf?.currency as string | undefined) ?? undefined;

    let query = context.supabase
      .from("trades")
      .select("trade_date,executed_at,side,symbol,quantity,price,instrument_ccy,asset_class")
      .eq("portfolio_id", data.portfolio_id)
      .order("trade_date", { ascending: true });

    if (data.days) {
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - data.days);
      query = query.gte("trade_date", cutoff.toISOString().slice(0, 10));
    }

    const { data: rows } = await query;
    const trades: FeeTradeInput[] = (rows ?? []).map((r) => ({
      trade_date: r.trade_date as string,
      executed_at: (r.executed_at as string | null) ?? null,
      side: r.side as "buy" | "sell",
      symbol: r.symbol as string,
      quantity: Number(r.quantity),
      price: Number(r.price),
      instrument_ccy: (r.instrument_ccy as string | null) ?? null,
      asset_class: (r.asset_class as string | null) ?? null,
    }));

    const breakdown = computeFeeBreakdown(trades, displayCurrency);
    const from = trades[0]?.trade_date ?? null;
    const to = trades[trades.length - 1]?.trade_date ?? null;
    return { ...breakdown, from, to };
  });
