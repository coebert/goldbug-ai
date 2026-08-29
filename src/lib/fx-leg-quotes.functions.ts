import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { parseFxPair, valueFxLeg, netClosePnl } from "@/lib/fx-leg-quotes";

export type FxLegQuote = {
  symbol: string;
  quantity: number;
  avgCost: number;
  /** Live market rate (quote ccy per 1 base ccy of the pair). */
  rate: number | null;
  pairBase: string;
  quoteCcy: string;
  pnlQuote: number;
  pnlBase: number;
  notionalQuote: number;
  notionalBase: number;
  /** Estimated one-way exit fee (spread + markup, min ticket) in quote ccy. */
  exitFeeQuote: number;
  exitFeeBase: number;
  exitCostBps: number;
  /** Close-now P&L after the exit fee, in quote ccy and portfolio base ccy. */
  pnlQuoteNet: number;
  pnlBaseNet: number;
  /** Rate observation time (ISO) and provider. */
  observedAt: string | null;
  source: string;
  stale: boolean;
};

export type FxLegQuotesResult = {
  baseCcy: string;
  asOf: string;
  legs: FxLegQuote[];
};

/**
 * Live mark-to-market of every open FX funding leg in a portfolio, plus the
 * P&L that would be realised if the leg were closed at the current rate.
 * FX legs carry negative quantities and are not in `price_cache`, so they
 * cannot be priced through the normal holdings-series path.
 */
export const getFxLegQuotes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ portfolioId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }): Promise<FxLegQuotesResult> => {
    const { getFxRateAudited } = await import("@/lib/fx.server");
    const { feeInFromCcy } = await import("@/lib/fx-cost-model");

    const [{ data: portfolio }, { data: holdings }] = await Promise.all([
      context.supabase
        .from("portfolios")
        .select("currency")
        .eq("id", data.portfolioId)
        .maybeSingle(),
      context.supabase
        .from("holdings")
        .select("symbol, quantity, avg_cost, asset_class, instrument_ccy")
        .eq("portfolio_id", data.portfolioId)
        .eq("asset_class", "fx"),
    ]);

    const baseCcy = String(portfolio?.currency ?? "GBP").toUpperCase();
    const rows = (holdings ?? []).filter((h) => Number(h.quantity) !== 0);

    const legs = await Promise.all(
      rows.map(async (h): Promise<FxLegQuote> => {
        const pair = parseFxPair(String(h.symbol), h.instrument_ccy ?? null);
        const pairBase = pair?.base ?? baseCcy;
        const quoteCcy = (pair?.quote ?? String(h.instrument_ccy ?? baseCcy)).toUpperCase();
        const qty = Number(h.quantity);
        const avgCost = Number(h.avg_cost);

        let rate: number | null = null;
        let observedAt: string | null = null;
        let source = "unavailable";
        let stale = true;
        try {
          const r = await getFxRateAudited(pairBase, quoteCcy);
          rate = r.rate;
          observedAt = new Date(r.observedAtMs).toISOString();
          source = r.source;
          stale = r.stale;
        } catch (e) {
          source = e instanceof Error ? e.message : "fx-error";
        }

        let quoteToBase = 1;
        if (quoteCcy !== baseCcy) {
          try {
            const r = await getFxRateAudited(quoteCcy, baseCcy);
            quoteToBase = r.rate;
          } catch {
            quoteToBase = rate && pairBase === baseCcy ? 1 / rate : 1;
          }
        }

        const v = valueFxLeg({
          quantity: qty,
          avgCost,
          rate: rate ?? avgCost,
          quoteToBase,
        });
        // Closing the leg means converting out of the quote currency at spot;
        // deduct the one-way exit cost (spread floored at the min ticket).
        const { fee, quote: costQuote } = feeInFromCcy(
          v.notionalQuote,
          quoteCcy,
          pairBase,
          "spot",
        );
        const net = netClosePnl({
          pnlQuote: v.pnlQuote,
          notionalQuote: v.notionalQuote,
          exitCostBps: costQuote.totalBps,
          minFeeQuote: v.notionalQuote > 0 ? Math.min(fee, costQuote.minFeeFrom) : 0,
        });
        return {
          symbol: String(h.symbol),
          quantity: qty,
          avgCost,
          rate,
          pairBase,
          quoteCcy,
          ...v,
          exitFeeQuote: net.exitFeeQuote,
          exitFeeBase: net.exitFeeQuote * (Number.isFinite(quoteToBase) && quoteToBase > 0 ? quoteToBase : 1),
          exitCostBps: net.exitCostBps,
          pnlQuoteNet: net.pnlQuoteNet,
          pnlBaseNet: net.pnlQuoteNet * (Number.isFinite(quoteToBase) && quoteToBase > 0 ? quoteToBase : 1),
          observedAt,
          source,
          stale,
        };
      }),
    );

    return { baseCcy, asOf: new Date().toISOString(), legs };
  });
