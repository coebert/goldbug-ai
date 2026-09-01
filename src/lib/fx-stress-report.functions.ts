import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { parseFxPair } from "@/lib/fx-leg-quotes";
import type { FxStressReport } from "@/lib/fx-stress-test";

export type FxStressLegReport = {
  symbol: string;
  pair: string;
  /** True when this is the user's actual open leg, false for the synthetic reference leg. */
  actual: boolean;
  quantity: number;
  avgCost: number;
  quoteCcy: string;
  report: FxStressReport;
  error?: string;
};

export type FxStressReportResponse = {
  baseCcy: string;
  asOf: string;
  years: number;
  legs: FxStressLegReport[];
};

/**
 * Stress-tests every open FX funding leg in the portfolio (plus a synthetic
 * GBPUSD reference leg when none is open) against instant rate shocks,
 * sigma-scaled gap moves, volatility-spike drifts and the worst moves in
 * ~20 years of ECB closes. All P&L is net of the spot exit fee.
 */
export const getFxStressReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        years: z.number().int().min(2).max(20).default(20),
        /** Portfolio NAV in base ccy, for % -of-NAV impact. Optional. */
        navBase: z.number().positive().optional(),
        /** Notional (quote ccy) for the synthetic reference leg. */
        referenceNotional: z.number().positive().default(10_000),
        /**
         * Pairs to synthesise a reference leg for when they are not held, so
         * the dashboard's currency picker can stress any pair, not just open
         * exposure.
         */
        referencePairs: z.array(z.string().length(6)).max(8).default(["GBPUSD"]),
      })
      .parse(i),
  )
  .handler(async ({ data, context }): Promise<FxStressReportResponse> => {
    const { fetchFxHistory, daysAgo } = await import("@/lib/fx-history.server");
    const { stressFxLeg } = await import("@/lib/fx-stress-test");
    const { quoteFxCost } = await import("@/lib/fx-cost-model");
    const { getFxRateAudited } = await import("@/lib/fx.server");

    const [{ data: portfolio }, { data: holdings }] = await Promise.all([
      context.supabase
        .from("portfolios")
        .select("currency")
        .eq("id", data.portfolioId)
        .maybeSingle(),
      context.supabase
        .from("holdings")
        .select("symbol, quantity, avg_cost, instrument_ccy")
        .eq("portfolio_id", data.portfolioId)
        .eq("asset_class", "fx"),
    ]);

    const baseCcy = String(portfolio?.currency ?? "GBP").toUpperCase();
    const from = daysAgo(Math.round(data.years * 365));

    type LegIn = { symbol: string; quantity: number; avgCost: number; quoteCcy: string; actual: boolean };
    const legsIn: LegIn[] = (holdings ?? [])
      .filter((h) => Number(h.quantity) !== 0)
      .map((h) => {
        const pair = parseFxPair(String(h.symbol), h.instrument_ccy ?? null);
        return {
          symbol: String(h.symbol),
          quantity: Number(h.quantity),
          avgCost: Number(h.avg_cost),
          quoteCcy: (pair?.quote ?? String(h.instrument_ccy ?? baseCcy)).toUpperCase(),
          actual: true,
        };
      });
    // Add a synthetic reference leg for every requested pair that is not held,
    // so the picker can stress any pair and never renders an empty card.
    for (const raw of data.referencePairs.length > 0 ? data.referencePairs : ["GBPUSD"]) {
      const ref = raw.toUpperCase();
      const quote = ref.slice(3, 6);
      if (legsIn.some((l) => `${parseFxPair(l.symbol, l.quoteCcy)?.base ?? ""}${l.quoteCcy}` === ref)) continue;
      if (legsIn.some((l) => l.symbol.toUpperCase().startsWith(ref))) continue;
      legsIn.push({
        symbol: ref,
        quantity: -data.referenceNotional, // short-base reference, sized below
        avgCost: 0, // set to the current rate once fetched
        quoteCcy: quote,
        actual: false,
      });
    }
        const pair = parseFxPair(l.symbol, l.quoteCcy);
        const pairBase = pair?.base ?? baseCcy;
        const pairKey = `${pairBase}${l.quoteCcy}`;
        try {
          const [bars, live] = await Promise.all([
            fetchFxHistory(pairBase, l.quoteCcy, from),
            getFxRateAudited(pairBase, l.quoteCcy).catch(() => null),
          ]);
          const rate = live?.rate ?? bars[bars.length - 1]?.rate ?? 0;
          if (!(rate > 0)) throw new Error("no rate available");

          let quoteToBase = 1;
          if (l.quoteCcy !== baseCcy) {
            try {
              quoteToBase = (await getFxRateAudited(l.quoteCcy, baseCcy)).rate;
            } catch {
              quoteToBase = pairBase === baseCcy ? 1 / rate : 1;
            }
          }

          const cost = quoteFxCost(l.quoteCcy, pairBase, "spot");
          const qty = l.actual ? l.quantity : -data.referenceNotional / rate;
          const avgCost = l.actual ? l.avgCost : rate;
          const report = stressFxLeg(
            { quantity: qty, avgCost, rate, quoteToBase },
            bars,
            { navBase: data.navBase, exitCostBps: cost.totalBps, minFeeQuote: cost.minFeeFrom },
          );
          return {
            symbol: l.symbol,
            pair: pairKey,
            actual: l.actual,
            quantity: qty,
            avgCost,
            quoteCcy: l.quoteCcy,
            report,
          };
        } catch (e) {
          return {
            symbol: l.symbol,
            pair: pairKey,
            actual: l.actual,
            quantity: l.quantity,
            avgCost: l.avgCost,
            quoteCcy: l.quoteCcy,
            report: {
              side: l.quantity < 0 ? "short" : "long",
              currentRate: 0,
              notionalQuote: 0,
              sigmaDaily: null,
              scenarios: [],
              worstCaseBase: 0,
              worstCaseLabel: "unavailable",
            },
            error: e instanceof Error ? e.message : "stress report unavailable",
          };
        }
      }),
    );

    // Actual positions first, then the reference leg.
    legs.sort((a, b) => Number(b.actual) - Number(a.actual));
    return { baseCcy, asOf: new Date().toISOString(), years: data.years, legs };
  });
