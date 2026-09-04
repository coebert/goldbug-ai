// Server read behind the daily P&L summary page.
// Arithmetic contract lives in src/lib/daily-pnl.ts.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  buildDailyPnl,
  groupByWeek,
  type DailyPnlDay,
  type DailyPnlInput,
  type WeeklyPnl,
} from "@/lib/daily-pnl";

export type DailyPnlResult = {
  currency: string;
  days: DailyPnlDay[];
  weeks: WeeklyPnl[];
  fxLegSymbols: string[];
  warnings: string[];
};

const EMPTY: DailyPnlResult = {
  currency: "GBP",
  days: [],
  weeks: [],
  fxLegSymbols: [],
  warnings: [],
};

export const getDailyPnl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        days: z.number().int().min(7).max(180).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<DailyPnlResult> => {
    const { supabase } = context;
    const windowDays = data.days ?? 60;

    const { data: portfolio } = await supabase
      .from("portfolios")
      .select("id, currency")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (!portfolio) return EMPTY;
    const baseCcy = String(portfolio.currency || "GBP").toUpperCase();

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - windowDays);
    const sinceDate = since.toISOString().slice(0, 10);

    const { data: changes, error: changeErr } = await supabase
      .from("daily_equity_changes")
      .select("change_date, prev_date, prev_equity, equity, pnl, net_flow")
      .eq("portfolio_id", data.portfolioId)
      .gte("change_date", sinceDate)
      .order("change_date", { ascending: true });
    if (changeErr) throw new Error(changeErr.message);
    if (!changes || changes.length === 0) return { ...EMPTY, currency: baseCcy };

    const warnings: string[] = [];

    // --- broker charges, by day -------------------------------------
    const { data: fills } = await supabase
      .from("live_fills")
      .select("fee, currency, filled_at")
      .eq("portfolio_id", data.portfolioId)
      .gte("filled_at", `${sinceDate}T00:00:00.000Z`);

    // --- FX hedge legs ----------------------------------------------
    const { data: holdingRows } = await supabase
      .from("holdings")
      .select("symbol, quantity, asset_class, instrument_ccy, opened_at")
      .eq("portfolio_id", data.portfolioId);
    const fxHoldings = (holdingRows ?? []).filter(
      (h) => String(h.asset_class ?? "") === "fx" && Number(h.quantity),
    );

    const [{ priceSymbolVariants }, { loadFxRates }] = await Promise.all([
      import("@/lib/price-symbol"),
      import("@/lib/valuation/value-holdings.server"),
    ]);

    const feeCcys = [
      ...new Set((fills ?? []).map((f) => String(f.currency || baseCcy).toUpperCase())),
    ];
    const fxCcys = [
      ...new Set(fxHoldings.map((h) => String(h.instrument_ccy || baseCcy).toUpperCase())),
    ];
    const rates = await loadFxRates([...feeCcys, ...fxCcys], baseCcy);
    const rateFor = (ccy: string) =>
      ccy.toUpperCase() === baseCcy ? 1 : (rates.get(`${ccy.toUpperCase()}>${baseCcy}`) ?? null);

    const feesByDate = new Map<string, number>();
    for (const f of fills ?? []) {
      const amt = Number(f.fee);
      if (!Number.isFinite(amt) || amt === 0) continue;
      const ccy = String(f.currency || baseCcy).toUpperCase();
      const rate = rateFor(ccy);
      if (rate == null) {
        warnings.push(`No ${ccy}→${baseCcy} rate — some charges are shown unconverted.`);
      }
      const day = String(f.filled_at).slice(0, 10);
      feesByDate.set(day, (feesByDate.get(day) ?? 0) + amt * (rate ?? 1));
    }

    // Closes per FX symbol, so a leg's daily move can be measured.
    const fxByDate = new Map<string, number>();
    const fxLegSymbols: string[] = [];
    for (const h of fxHoldings) {
      const qty = Number(h.quantity);
      const ccy = String(h.instrument_ccy || baseCcy).toUpperCase();
      const rate = rateFor(ccy) ?? 1;
      const lookback = new Date(`${sinceDate}T00:00:00Z`);
      lookback.setUTCDate(lookback.getUTCDate() - 7);
      const { data: bars } = await supabase
        .from("price_cache")
        .select("price_date, close")
        .in("symbol", priceSymbolVariants(String(h.symbol)))
        .gte("price_date", lookback.toISOString().slice(0, 10))
        .order("price_date", { ascending: true });
      const closes = (bars ?? [])
        .map((b) => ({ date: String(b.price_date), close: Number(b.close) }))
        .filter((b) => Number.isFinite(b.close) && b.close > 0);
      if (closes.length < 2) {
        warnings.push(`No stored rate history for ${h.symbol} — its leg is folded into positions.`);
        continue;
      }
      fxLegSymbols.push(String(h.symbol));
      const openedDate = h.opened_at ? String(h.opened_at).slice(0, 10) : null;
      for (let i = 1; i < closes.length; i += 1) {
        const cur = closes[i]!;
        const prev = closes[i - 1]!;
        if (openedDate && cur.date < openedDate) continue;
        const change = qty * (cur.close - prev.close) * rate;
        fxByDate.set(cur.date, (fxByDate.get(cur.date) ?? 0) + change);
      }
    }

    const inputs: DailyPnlInput[] = changes.map((c) => {
      const date = String(c.change_date);
      return {
        date,
        prevDate: c.prev_date ? String(c.prev_date) : null,
        prevEquity: Number(c.prev_equity) || 0,
        equity: Number(c.equity) || 0,
        netPnl: Number(c.pnl) || 0,
        netFlow: Number(c.net_flow) || 0,
        fxLegs: fxByDate.get(date) ?? 0,
        fees: feesByDate.get(date) ?? 0,
      };
    });

    const days = buildDailyPnl(inputs);
    return {
      currency: baseCcy,
      days,
      weeks: groupByWeek(days),
      fxLegSymbols,
      warnings: [...new Set(warnings)],
    };
  });
