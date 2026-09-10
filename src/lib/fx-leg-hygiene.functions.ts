// Reads the open FX funding legs and the foreign-currency holdings they are
// meant to be paying for, then applies the housekeeping rule in
// `fx-leg-hygiene.ts` so the UI can flag legs that have outlived their purpose.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { parseFxPair } from "@/lib/fx-leg-quotes";
import { assessFxLegs, type HygieneAssessment, type HygieneLegInput } from "@/lib/fx-leg-hygiene";

export type FxLegHygieneResult = {
  asOf: string;
  legs: HygieneAssessment[];
};

export const getFxLegHygiene = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ portfolioId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }): Promise<FxLegHygieneResult> => {
    const { getFxRateAudited } = await import("@/lib/fx.server");

    const [{ data: portfolio }, { data: holdings }] = await Promise.all([
      context.supabase
        .from("portfolios")
        .select("currency")
        .eq("id", data.portfolioId)
        .maybeSingle(),
      context.supabase
        .from("holdings")
        .select("symbol, quantity, avg_cost, asset_class, instrument_ccy, opened_at")
        .eq("portfolio_id", data.portfolioId),
    ]);

    const baseCcy = String(portfolio?.currency ?? "GBP").toUpperCase();
    const rows = holdings ?? [];

    // Exposure = cost basis of the non-FX holdings held in each currency.
    const exposureByCcy: Record<string, number> = {};
    for (const h of rows) {
      if (h.asset_class === "fx") continue;
      const qty = Number(h.quantity);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const ccy = String(h.instrument_ccy ?? baseCcy).toUpperCase();
      exposureByCcy[ccy] = (exposureByCcy[ccy] ?? 0) + qty * Number(h.avg_cost ?? 0);
    }

    const legInputs: HygieneLegInput[] = [];
    for (const h of rows) {
      if (h.asset_class !== "fx") continue;
      const qty = Number(h.quantity);
      if (!Number.isFinite(qty) || qty === 0) continue;
      const pair = parseFxPair(String(h.symbol), h.instrument_ccy ?? null);
      const pairBase = (pair?.base ?? baseCcy).toUpperCase();
      const quoteCcy = (pair?.quote ?? String(h.instrument_ccy ?? baseCcy)).toUpperCase();
      const notionalQuote = Math.abs(qty) * Number(h.avg_cost ?? 0);

      let notionalBase = Math.abs(qty);
      if (pairBase !== baseCcy) {
        try {
          const r = await getFxRateAudited(pairBase, baseCcy);
          const rate = typeof r === "number" ? r : (r?.rate ?? null);
          if (rate && Number.isFinite(rate)) notionalBase = Math.abs(qty) * rate;
        } catch {
          // Leave the leg sized in its own base ccy; the rule only uses this
          // for the "too small to bother" cut-off.
        }
      }

      legInputs.push({
        symbol: String(h.symbol),
        quantity: qty,
        quoteCcy,
        openedAt: h.opened_at ?? null,
        notionalQuote,
        notionalBase,
      });
    }

    return {
      asOf: new Date().toISOString(),
      legs: assessFxLegs(legInputs, exposureByCcy),
    };
  });
