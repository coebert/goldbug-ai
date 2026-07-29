// Per-currency wallet + holdings exposure for the portfolio overview.
// Returns cash by currency, holdings market value by instrument currency
// (LSE GBX normalized to GBP), and each bucket converted into the portfolio's
// base currency using the same FX matrix the executor consults.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { readWallet } from "./portfolio-wallet";
import { valueHoldings, type MultiCcyHolding } from "./multi-ccy-holdings";
import { getFxMatrix } from "./fx.server";
import { normalizeLseDisplayPriceToBase } from "./market-price-units";

export type MultiCurrencyExposureRow = {
  currency: string;
  cashNative: number;
  holdingsNative: number;
  totalNative: number;
  cashBase: number;
  holdingsBase: number;
  totalBase: number;
  fxRateToBase: number;
  fxSource: string;
  fxStale: boolean;
  pctOfEquity: number;
};

export type MultiCurrencyExposureResult = {
  baseCcy: string;
  fxEnabled: boolean;
  totalCashBase: number;
  totalHoldingsBase: number;
  totalEquityBase: number;
  usedStaleRate: boolean;
  staleRatePairs: string[];
  rows: MultiCurrencyExposureRow[];
};

export const getMultiCurrencyExposure = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({ portfolioId: z.string().uuid() }).parse(i),
  )
  .handler(async ({ data, context }): Promise<MultiCurrencyExposureResult> => {
    const { supabase } = context;

    const { data: p, error } = await supabase
      .from("portfolios")
      .select("id, currency, current_cash, cash_by_ccy, fx_enabled")
      .eq("id", data.portfolioId)
      .single();
    if (error || !p) throw new Error(error?.message ?? "Portfolio not found");

    const baseCcy = String(p.currency ?? "GBP").toUpperCase();
    const rawCashByCcy =
      p.cash_by_ccy && typeof p.cash_by_ccy === "object" && !Array.isArray(p.cash_by_ccy)
        ? (p.cash_by_ccy as Record<string, number>)
        : null;
    const wallet = readWallet({
      currency: p.currency,
      current_cash: p.current_cash,
      cash_by_ccy: rawCashByCcy,
    });

    const { data: holdingsRows } = await supabase
      .from("holdings")
      .select("symbol, asset_class, quantity, instrument_ccy")
      .eq("portfolio_id", data.portfolioId);

    const holdings = (holdingsRows ?? []).filter((h) => Number(h.quantity) > 0);

    // Latest close per symbol from price_cache.
    const symbols = Array.from(new Set(holdings.map((h) => h.symbol)));
    const priceMap = new Map<string, number>();
    if (symbols.length > 0) {
      const { data: pc } = await supabase
        .from("price_cache")
        .select("symbol, close, price_date")
        .in("symbol", symbols)
        .order("price_date", { ascending: false })
        .limit(symbols.length * 6);
      for (const r of pc ?? []) {
        if (!priceMap.has(r.symbol)) priceMap.set(r.symbol, Number(r.close));
      }
    }

    const priced: MultiCcyHolding[] = holdings.map((h) => {
      const raw = priceMap.get(h.symbol) ?? 0;
      const ccy = String(h.instrument_ccy ?? baseCcy).toUpperCase();
      // Fold LSE GBX pence into GBP so per-currency totals compare like-for-like.
      const price = ccy === "GBP"
        ? normalizeLseDisplayPriceToBase(h.symbol, raw, h.asset_class)
        : raw;
      return {
        symbol: h.symbol,
        quantity: Number(h.quantity),
        price,
        instrument_ccy: ccy,
      };
    });

    // Build the FX matrix once for every currency in play → base.
    const ccysInPlay = new Set<string>([baseCcy, ...Object.keys(wallet)]);
    for (const h of priced) ccysInPlay.add(h.instrument_ccy);
    const pairs: Array<{ from: string; to: string }> = [];
    for (const c of ccysInPlay) if (c !== baseCcy) pairs.push({ from: c, to: baseCcy });
    let matrix = new Map<string, { rate: number; source: string; stale: boolean }>();
    try {
      const m = await getFxMatrix(pairs);
      for (const [k, v] of m.entries()) {
        matrix.set(k, { rate: v.rate, source: v.source, stale: v.stale });
      }
    } catch {
      matrix = new Map();
    }

    const fxLookup = (from: string, to: string): number => {
      if (from === to) return 1;
      return matrix.get(`${from}${to}`)?.rate ?? NaN;
    };
    const isStale = (from: string, to: string): boolean => {
      if (from === to) return false;
      return matrix.get(`${from}${to}`)?.stale ?? true;
    };

    const valuation = valueHoldings(priced, wallet, baseCcy, fxLookup, isStale);

    const totalEquityBase = valuation.totalBaseCcy;
    const rows: MultiCurrencyExposureRow[] = Object.entries(valuation.byCurrency)
      .map(([ccy, v]) => {
        const rateInfo = ccy === baseCcy
          ? { rate: 1, source: "identity", stale: false }
          : matrix.get(`${ccy}${baseCcy}`) ?? { rate: 1, source: "missing", stale: true };
        const rate = Number.isFinite(rateInfo.rate) && rateInfo.rate > 0 ? rateInfo.rate : 1;
        const cashBase = v.cash * rate;
        const holdingsBase = v.holdings * rate;
        const totalBase = cashBase + holdingsBase;
        return {
          currency: ccy,
          cashNative: v.cash,
          holdingsNative: v.holdings,
          totalNative: v.total,
          cashBase,
          holdingsBase,
          totalBase,
          fxRateToBase: rate,
          fxSource: rateInfo.source,
          fxStale: rateInfo.stale,
          pctOfEquity: totalEquityBase > 0 ? totalBase / totalEquityBase : 0,
        };
      })
      .sort((a, b) => {
        if (a.currency === baseCcy) return -1;
        if (b.currency === baseCcy) return 1;
        return Math.abs(b.totalBase) - Math.abs(a.totalBase);
      });

    return {
      baseCcy,
      fxEnabled: p.fx_enabled === true,
      totalCashBase: valuation.cashBaseCcy,
      totalHoldingsBase: valuation.holdingsBaseCcy,
      totalEquityBase,
      usedStaleRate: valuation.usedStaleRate,
      staleRatePairs: valuation.staleRatePairs,
      rows,
    };
  });
