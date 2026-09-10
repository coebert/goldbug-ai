import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { buildCostModelGap, type CostGapOrder, type CostGapFill } from "./cost-model-gap";
import {
  ASSUMPTION_PRESET_IDS,
  DEFAULT_BACKTEST_PRESET,
  describeAssumptions,
  resolveAssumptions,
  type AssumptionPresetId,
} from "./backtest/execution-assumptions";
import { normalizeMarketPriceForTrading } from "./market-price-units";

export const getCostModelGap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        limit: z.number().int().min(5).max(300).optional(),
        preset: z.enum(ASSUMPTION_PRESET_IDS as [AssumptionPresetId, ...AssumptionPresetId[]]).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const limit = data.limit ?? 40;

    const [portfolioRes, ordersRes] = await Promise.all([
      db.from("portfolios").select("currency").eq("id", data.portfolioId).single(),
      db
        .from("live_orders")
        .select("id,symbol,side,quantity,status,instrument_ccy,created_at")
        .eq("portfolio_id", data.portfolioId)
        .order("created_at", { ascending: false })
        .limit(limit),
    ]);
    if (portfolioRes.error || !portfolioRes.data) {
      throw new Error(portfolioRes.error?.message ?? "Portfolio not found");
    }
    if (ordersRes.error) throw new Error(ordersRes.error.message);

    const currency = String(portfolioRes.data.currency ?? "GBP").toUpperCase();
    const orderRows = ordersRes.data ?? [];
    const orderIds = orderRows.map((o) => String(o.id));

    const fillsRes = orderIds.length
      ? await db
          .from("live_fills")
          .select("order_id,quantity,fill_price,fee,fee_source,currency,filled_at,symbol")
          .in("order_id", orderIds)
          .limit(5000)
      : { data: [], error: null as null | { message: string } };
    if (fillsRes.error) throw new Error(fillsRes.error.message);

    const { convertAmount } = await import("./fx.server");
    const rates = new Map<string, number>();
    const rateFor = async (from: string): Promise<number> => {
      const code = String(from || currency).toUpperCase();
      if (code === currency) return 1;
      const cached = rates.get(code);
      if (cached != null) return cached;
      const converted = await convertAmount(1, code, currency).catch(() => ({ amount: NaN }));
      const value = Number(converted.amount);
      const safe = Number.isFinite(value) && value > 0 ? value : 1;
      rates.set(code, safe);
      return safe;
    };

    const byOrder = new Map<string, CostGapFill[]>();
    for (const row of fillsRes.data ?? []) {
      const orderId = String(row.order_id ?? "");
      const quantity = Number(row.quantity ?? 0);
      const symbol = String(row.symbol ?? "");
      const price = normalizeMarketPriceForTrading(symbol, Number(row.fill_price ?? 0));
      if (!orderId || !(quantity > 0) || !(price > 0)) continue;
      const fx = await rateFor(String(row.currency ?? currency));
      const source = String(row.fee_source ?? "");
      const list = byOrder.get(orderId) ?? [];
      list.push({
        quantity,
        priceBase: price * fx,
        feeBase: Math.abs(Number(row.fee ?? 0)) * fx,
        feeSource: source === "broker" ? "broker" : source === "model" ? "model" : "none",
        filledAt: String(row.filled_at ?? ""),
      });
      byOrder.set(orderId, list);
    }

    const orders: CostGapOrder[] = orderRows.map((o) => ({
      id: String(o.id),
      symbol: String(o.symbol ?? ""),
      side: String(o.side ?? "").toLowerCase() === "sell" ? "sell" : "buy",
      orderedQuantity: Number(o.quantity ?? 0),
      status: String(o.status ?? ""),
      foreign: String(o.instrument_ccy ?? currency).toUpperCase() !== currency,
      createdAt: String(o.created_at ?? ""),
      fills: byOrder.get(String(o.id)) ?? [],
    }));

    const presetId = data.preset ?? DEFAULT_BACKTEST_PRESET;
    const assumptions = resolveAssumptions(presetId);
    const gap = buildCostModelGap(orders, assumptions);

    return {
      currency,
      preset: presetId,
      assumptions: describeAssumptions(assumptions),
      ...gap,
    };
  });
