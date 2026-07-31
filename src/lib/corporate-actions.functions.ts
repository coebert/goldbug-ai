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

/** Wire shape: the raw Saxo row is dropped (not serializable / not needed). */
export type CorporateActionView = Omit<CorporateAction, "raw">;

export type CorporateActionsResult = {
  portfolioId: string;
  /** false when the portfolio is not linked to a broker account. */
  brokerBacked: boolean;
  /** false when Saxo does not expose corporate actions on this environment. */
  supported: boolean;
  env: string | null;
  endpoint: string | null;
  fetchedAt: string;
  events: CorporateActionView[];
  /** Human-readable reason when nothing could be fetched. */
  reason: string | null;
};

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
    const all = sortByDeadline(normalizeCorporateActions(res.events)).map(
      ({ raw: _raw, ...view }): CorporateActionView => view,
    );
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
