// Live position-risk read for the risk dashboard.
//
// Everything here is derived from the same valuation kernel the portfolio
// totals use, so a weight on this page can never disagree with the equity
// number elsewhere. Prices come from the broker's own quotes when the feed is
// available and fall back to the cached daily tape per symbol.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type PositionRiskRow = {
  symbol: string;
  assetClass: string | null;
  quantity: number;
  price: number | null;
  priceSource: "broker" | "cache" | "cost_basis" | "missing";
  instrumentCurrency: string;
  nativeValue: number;
  baseValue: number;
  weightPct: number;
  avgCost: number | null;
  unrealisedPct: number | null;
};

export type CashAtRiskRow = {
  currency: string;
  amount: number;
  baseValue: number;
  weightPct: number;
  /** True when the balance is not in the portfolio's base currency. */
  atFxRisk: boolean;
};

export type PositionRiskReport = {
  baseCurrency: string;
  totalValue: number;
  holdingsValue: number;
  cash: number;
  rows: PositionRiskRow[];
  cashRows: CashAtRiskRow[];
  fxLegs: PositionRiskRow[];
  concentration: {
    topWeightPct: number;
    top3WeightPct: number;
    /** Herfindahl index over position weights (0 = diversified, 1 = one name). */
    hhi: number;
    /** Equivalent number of equally-weighted positions. */
    effectivePositions: number;
    cashAtFxRiskPct: number;
  };
  brokerPriced: number;
  requested: number;
  degraded: boolean;
  warnings: string[];
};

export const getPositionRisk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ portfolioId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }): Promise<PositionRiskReport> => {
    const { supabase } = context;

    const { data: p } = await supabase
      .from("portfolios")
      .select("id, currency, current_cash, cash_by_ccy")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (!p) throw new Error("Portfolio not found or not accessible.");

    const { data: holdingRows } = await supabase
      .from("holdings")
      .select("symbol, quantity, avg_cost, asset_class, instrument_ccy")
      .eq("portfolio_id", data.portfolioId);

    const holdings = (holdingRows ?? []).filter((h) => Number(h.quantity) !== 0);
    const baseCcy = String(p.currency || "GBP").toUpperCase();
    const wallet: Record<string, number> =
      (p.cash_by_ccy as Record<string, number> | null) ?? {
        [baseCcy]: Number(p.current_cash) || 0,
      };

    const { normalizeLseDisplayPriceToBase } = await import("@/lib/market-price-units");
    const { priceSymbolVariants } = await import("@/lib/price-symbol");

    const symbols = [...new Set(holdings.map((h) => h.symbol))];
    const normalizedPrices = new Map<string, number>();
    const sourceBySymbol = new Map<string, "broker" | "cache">();

    // Broker tape first — these are the prices our orders execute against.
    if (symbols.length > 0) {
      try {
        const { fetchBrokerQuotes } = await import("@/lib/brokers/saxo-prices.server");
        const quotes = await fetchBrokerQuotes(symbols, { portfolioId: data.portfolioId });
        for (const [symbol, q] of Object.entries(quotes)) {
          const h = holdings.find((x) => x.symbol === symbol);
          const px = normalizeLseDisplayPriceToBase(symbol, Number(q.price), h?.asset_class ?? null);
          if (Number.isFinite(px) && px > 0) {
            normalizedPrices.set(symbol, px);
            sourceBySymbol.set(symbol, "broker");
          }
        }
      } catch (err) {
        console.warn("getPositionRisk: broker quotes unavailable", err);
      }
    }

    // Cached daily tape for anything the broker could not price.
    for (const h of holdings) {
      if (normalizedPrices.has(h.symbol)) continue;
      const { data: pc } = await supabase
        .from("price_cache")
        .select("close")
        .in("symbol", priceSymbolVariants(h.symbol))
        .order("price_date", { ascending: false })
        .limit(1);
      const close = pc && pc[0] ? Number(pc[0].close) : NaN;
      const px = normalizeLseDisplayPriceToBase(h.symbol, close, h.asset_class ?? null);
      if (Number.isFinite(px) && px > 0) {
        normalizedPrices.set(h.symbol, px);
        sourceBySymbol.set(h.symbol, "cache");
      }
    }

    const { valuePortfolioHoldings } = await import("@/lib/valuation/value-holdings.server");
    const valuation = await valuePortfolioHoldings({
      holdings: holdings.map((h) => ({
        symbol: h.symbol,
        quantity: Number(h.quantity),
        avg_cost: h.avg_cost,
        asset_class: h.asset_class,
        instrument_ccy: h.instrument_ccy,
      })),
      normalizedPrices,
      wallet,
      baseCcy,
    });

    const total = valuation.totalValue || 0;
    const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);

    const rows: PositionRiskRow[] = valuation.provenance.lines.map((l) => {
      const h = holdings.find((x) => x.symbol === l.symbol);
      const avgCostNative =
        h?.avg_cost == null
          ? null
          : normalizeLseDisplayPriceToBase(l.symbol, Number(h.avg_cost), h.asset_class ?? null);
      const unitPrice = l.quantity !== 0 ? l.nativeValue / l.quantity : null;
      return {
        symbol: l.symbol,
        assetClass: h?.asset_class ?? null,
        quantity: l.quantity,
        price: unitPrice,
        priceSource:
          l.priceSource === "market"
            ? (sourceBySymbol.get(l.symbol) ?? "cache")
            : l.priceSource === "cost_basis"
              ? "cost_basis"
              : "missing",
        instrumentCurrency: l.instrumentCurrency,
        nativeValue: l.nativeValue,
        baseValue: l.baseValue,
        weightPct: pct(Math.abs(l.baseValue)),
        avgCost: avgCostNative,
        unrealisedPct:
          avgCostNative && unitPrice && avgCostNative > 0
            ? ((unitPrice - avgCostNative) / avgCostNative) * 100
            : null,
      };
    });
    rows.sort((a, b) => Math.abs(b.baseValue) - Math.abs(a.baseValue));

    const cashRows: CashAtRiskRow[] = valuation.provenance.cash.map((c) => ({
      currency: c.currency,
      amount: c.amount,
      baseValue: c.baseValue,
      weightPct: pct(Math.abs(c.baseValue)),
      atFxRisk: c.currency.toUpperCase() !== baseCcy,
    }));
    cashRows.sort((a, b) => Math.abs(b.baseValue) - Math.abs(a.baseValue));

    const positionRows = rows.filter((r) => r.assetClass !== "fx");
    const weights = positionRows.map((r) => r.weightPct / 100);
    const hhi = weights.reduce((s, w) => s + w * w, 0);

    return {
      baseCurrency: baseCcy,
      totalValue: total,
      holdingsValue: valuation.holdingsValue,
      cash: valuation.cash,
      rows,
      cashRows,
      fxLegs: rows.filter((r) => r.assetClass === "fx"),
      concentration: {
        topWeightPct: positionRows[0]?.weightPct ?? 0,
        top3WeightPct: positionRows.slice(0, 3).reduce((s, r) => s + r.weightPct, 0),
        hhi,
        effectivePositions: hhi > 0 ? 1 / hhi : 0,
        cashAtFxRiskPct: cashRows.filter((c) => c.atFxRisk).reduce((s, c) => s + c.weightPct, 0),
      },
      brokerPriced: [...sourceBySymbol.values()].filter((s) => s === "broker").length,
      requested: symbols.length,
      degraded: valuation.provenance.degraded,
      warnings: valuation.provenance.warnings.map((w) => w.message),
    };
  });
