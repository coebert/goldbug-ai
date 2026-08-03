// Read-only corporate-actions feed for a broker-backed portfolio.
//
// Aegis lists pending events, their election options and their deadlines so
// nothing sits unnoticed in an inbox. It deliberately does NOT submit
// elections: those are irrevocable, and they stay a manual action in the
// Saxo platform.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { CorporateAction } from "./corporate-actions";
import type { ImpactPreview } from "./corporate-action-impact";

import { baseTicker } from "./corporate-actions.helpers";
import type { CorporateActionView, CorporateActionsResult } from "./corporate-actions.helpers";
export type { CorporateActionView, CorporateActionsResult };

export const listCorporateActions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ portfolioId: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }): Promise<CorporateActionsResult> => {
    const fetchedAt = new Date().toISOString();
    const empty = (
      patch: Partial<CorporateActionsResult>,
    ): CorporateActionsResult => ({
      portfolioId: data.portfolioId,
      brokerBacked: false,
      supported: false,
      env: null,
      endpoint: null,
      fetchedAt,
      events: [],
      reason: null,
      ...patch,
    });

    const { data: p, error } = await context.supabase
      .from("portfolios")
      .select("id, mode, broker, broker_account_id")
      .eq("id", data.portfolioId)
      .single();
    if (error || !p) throw new Error(error?.message ?? "Portfolio not found");

    const { resolvePortfolioBrokerLink } = await import(
      "@/lib/brokers/portfolio-broker-link.server"
    );
    const link = resolvePortfolioBrokerLink(p);
    if (!link.linked) {
      return empty({ reason: link.reason });
    }

    const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
    const env = p.mode === "live_prod" ? "live" : "sim";
    const adapter = await buildSaxoAdapter({
      userId: context.userId,
      portfolioId: data.portfolioId,
      envOverride: env,
      accountKey: link.accountKey,
    });

    const res = await adapter.listCorporateActions();
    if (!res.supported) {
      return empty({
        brokerBacked: true,
        env,
        reason:
          "Saxo did not expose a corporate-actions endpoint on this environment. Check pending events directly in the Saxo platform.",
      });
    }

    const { normalizeCorporateActions, sortByDeadline } = await import(
      "./corporate-actions"
    );
    const normalized = sortByDeadline(normalizeCorporateActions(res.events));

    // Pull the positions and last closes needed to price each election.
    const { data: holdings } = await context.supabase
      .from("holdings")
      .select("symbol, quantity, avg_cost, instrument_ccy")
      .eq("portfolio_id", data.portfolioId);
    const bySymbol = new Map(
      (holdings ?? []).map((h) => [baseTicker(h.symbol), h]),
    );

    const symbols = [...new Set((holdings ?? []).map((h) => h.symbol))];
    const prices = new Map<string, number>();
    if (symbols.length) {
      const { data: rows } = await context.supabase
        .from("price_cache")
        .select("symbol, close, price_date")
        .in("symbol", symbols)
        .order("price_date", { ascending: false })
        .limit(500);
      for (const r of rows ?? []) {
        const key = baseTicker(r.symbol);
        if (!prices.has(key) && Number.isFinite(r.close)) prices.set(key, r.close);
      }
    }

    const { buildImpactPreview } = await import("./corporate-action-impact");
    const { normalizeMarketPriceForTrading } = await import("./market-price-units");

    const all = normalized.map(({ raw: _raw, ...view }): CorporateActionView => {
      const key = baseTicker(view.symbol ?? view.instrument ?? "");
      const h = key ? bySymbol.get(key) : undefined;
      let position = null as null | {
        quantity: number;
        price: number | null;
        currency: string;
      };
      if (h) {
        const cached = prices.get(key);
        const price =
          cached != null
            ? normalizeMarketPriceForTrading(h.symbol, cached)
            : Number(h.avg_cost) || null;
        position = {
          quantity: Number(h.quantity) || 0,
          price,
          currency: h.instrument_ccy || "GBP",
        };
      }
      return { ...view, impact: buildImpactPreview(view.options, position) };
    });
    // Only surface events for this portfolio's account when Saxo tags them.
    const scoped = all.filter(
      (e) => e.accountKey == null || e.accountKey === link.accountKey,
    );

    return {
      portfolioId: data.portfolioId,
      brokerBacked: true,
      supported: true,
      env,
      endpoint: res.endpoint,
      fetchedAt,
      events: scoped,
      reason: null,
    };
  });
