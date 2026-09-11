// Loads holdings, prices, FX rates, rate volatility and open funding legs, then
// applies the pure rule in `holding-currency-risk.ts`.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  buildHoldingCurrencyRisk,
  dailyVolFromRates,
  fallbackDailyVol,
  type CurrencyRiskHoldingInput,
  type HoldingCurrencyRiskResult,
} from "./holding-currency-risk";
import { normalizeLseDisplayPriceToBase } from "./market-price-units";
import { parseFxPair } from "./fx-leg-quotes";

export type HoldingCurrencyRiskPayload = HoldingCurrencyRiskResult & {
  asOf: string;
  /** Currencies whose volatility fell back to a default because no history loaded. */
  estimatedVolCcys: string[];
};

export const getHoldingCurrencyRisk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ portfolioId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }): Promise<HoldingCurrencyRiskPayload> => {
    const db = context.supabase;
    const [{ data: portfolio, error: pErr }, { data: holdingRows, error: hErr }] =
      await Promise.all([
        db
          .from("portfolios")
          .select("currency, current_cash")
          .eq("id", data.portfolioId)
          .maybeSingle(),
        db
          .from("holdings")
          .select("symbol, quantity, avg_cost, asset_class, instrument_ccy")
          .eq("portfolio_id", data.portfolioId),
      ]);
    if (pErr) throw new Error(pErr.message);
    if (hErr) throw new Error(hErr.message);

    const baseCcy = String(portfolio?.currency ?? "GBP").toUpperCase();
    const rows = holdingRows ?? [];
    const positions = rows.filter(
      (h) => h.asset_class !== "fx" && Math.abs(Number(h.quantity ?? 0)) > 0,
    );

    // Latest close per symbol.
    const symbols = Array.from(new Set(positions.map((h) => String(h.symbol))));
    const priceMap = new Map<string, number>();
    if (symbols.length > 0) {
      const { data: pc } = await db
        .from("price_cache")
        .select("symbol, close, price_date")
        .in("symbol", symbols)
        .order("price_date", { ascending: false })
        .limit(symbols.length * 6);
      for (const r of pc ?? []) {
        if (!priceMap.has(r.symbol)) priceMap.set(r.symbol, Number(r.close));
      }
    }

    const { getFxRateAudited } = await import("./fx.server");
    const rateCache = new Map<string, number>();
    const rateToBase = async (from: string): Promise<number> => {
      const f = from.toUpperCase();
      if (f === baseCcy) return 1;
      const hit = rateCache.get(f);
      if (hit != null) return hit;
      let rate = 1;
      try {
        const r = await getFxRateAudited(f, baseCcy);
        const v = typeof r === "number" ? r : (r?.rate ?? null);
        if (v && Number.isFinite(v) && v > 0) rate = v;
      } catch {
        // Keep 1: the position still shows, flagged by its fallback volatility.
      }
      rateCache.set(f, rate);
      return rate;
    };

    const holdings: CurrencyRiskHoldingInput[] = [];
    for (const h of positions) {
      const symbol = String(h.symbol);
      const ccy = String(h.instrument_ccy ?? baseCcy).toUpperCase();
      const qty = Number(h.quantity);
      const rawPrice = priceMap.get(symbol) ?? Number(h.avg_cost ?? 0);
      // LSE quotes arrive in pence; fold them to pounds before valuing.
      const price =
        ccy === "GBP"
          ? normalizeLseDisplayPriceToBase(symbol, rawPrice, h.asset_class)
          : rawPrice;
      const valueNative = qty * (Number.isFinite(price) ? price : 0);
      const valueBase = valueNative * (await rateToBase(ccy));
      holdings.push({ symbol, currency: ccy, valueBase });
    }

    // Open funding legs offset part of the exposure in the currency they bought.
    const hedgedBaseByCcy: Record<string, number> = {};
    for (const h of rows) {
      if (h.asset_class !== "fx") continue;
      const qty = Number(h.quantity);
      if (!Number.isFinite(qty) || qty === 0) continue;
      const pair = parseFxPair(String(h.symbol), h.instrument_ccy ?? null);
      const pairBase = (pair?.base ?? baseCcy).toUpperCase();
      const quoteCcy = (pair?.quote ?? baseCcy).toUpperCase();
      if (quoteCcy === baseCcy) continue;
      const notionalBase = Math.abs(qty) * (await rateToBase(pairBase));
      hedgedBaseByCcy[quoteCcy] = (hedgedBaseByCcy[quoteCcy] ?? 0) + notionalBase;
    }

    // Rate volatility from daily ECB closes, per foreign currency in the book.
    const foreignCcys = Array.from(
      new Set(holdings.map((h) => h.currency).filter((c) => c !== baseCcy)),
    );
    const dailyVolByCcy: Record<string, number> = {};
    const estimatedVolCcys: string[] = [];
    if (foreignCcys.length > 0) {
      const { fetchFxHistory } = await import("./fx-history.server");
      const from = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
      await Promise.all(
        foreignCcys.map(async (ccy) => {
          try {
            const bars = await fetchFxHistory(ccy, baseCcy, from);
            const vol = dailyVolFromRates(bars.map((b) => b.rate));
            if (vol != null) {
              dailyVolByCcy[ccy] = vol;
              return;
            }
          } catch {
            // fall through to the default below
          }
          dailyVolByCcy[ccy] = fallbackDailyVol(ccy);
          estimatedVolCcys.push(ccy);
        }),
      );
    }

    const cashBase = Number(portfolio?.current_cash ?? 0);
    const equityBase =
      holdings.reduce((a, h) => a + Math.abs(h.valueBase), 0) + Math.max(0, cashBase);

    const result = buildHoldingCurrencyRisk({
      baseCcy,
      holdings,
      equityBase,
      dailyVolByCcy,
      hedgedBaseByCcy,
    });

    return { ...result, asOf: new Date().toISOString(), estimatedVolCcys };
  });
