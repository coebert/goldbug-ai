import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type BrokerStreamSubscription = {
  referenceId: string;
  symbol: string;
  uic: number;
  assetType: string;
  currency: string;
  price: number | null;
  bid: number | null;
  ask: number | null;
  at: string;
};

export type BrokerStreamSession =
  | {
      ok: true;
      contextId: string;
      wsUrl: string;
      inactivityTimeoutSec: number;
      subscriptions: BrokerStreamSubscription[];
    }
  | { ok: false; reason: string };

/**
 * Open a Saxo streaming price context for a portfolio's open positions.
 *
 * The dashboard used to re-ask the broker for every price on a 60s timer, so a
 * move only showed up on the next poll. Saxo pushes ticks instead; the socket
 * has to live in a long-running process and this app's server side is
 * request-scoped, so the page holds it.
 *
 * The returned connect URL embeds the broker token. It is handed only to the
 * authenticated owner of the account, and the page keeps it in memory.
 */
export const openBrokerPriceStream = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ portfolioId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }): Promise<BrokerStreamSession> => {
    const { data: portfolio } = await context.supabase
      .from("portfolios")
      .select("id")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (!portfolio) return { ok: false, reason: "not-found" };

    const { data: holdings } = await context.supabase
      .from("holdings")
      .select("symbol, quantity")
      .eq("portfolio_id", data.portfolioId);
    const { isBrokerRoutable, getBrokerPriceAdapter } = await import(
      "@/lib/brokers/saxo-prices.server"
    );
    const symbols = Array.from(
      new Set(
        (holdings ?? [])
          .filter((h) => Number(h.quantity) !== 0)
          .map((h) => String(h.symbol))
          .filter(isBrokerRoutable),
      ),
    );
    if (symbols.length === 0) return { ok: false, reason: "no-positions" };

    try {
      const adapter = await getBrokerPriceAdapter(data.portfolioId);
      if (!adapter) return { ok: false, reason: "no-broker" };
      const session = await adapter.openInfoPriceStream(symbols);
      if (session.subscriptions.length === 0) {
        await adapter.closeStreamingContext(session.contextId);
        return { ok: false, reason: "no-quotable-positions" };
      }
      return {
        ok: true,
        contextId: session.contextId,
        wsUrl: session.wsUrl,
        inactivityTimeoutSec: session.inactivityTimeoutSec,
        subscriptions: session.subscriptions,
      };
    } catch (err) {
      console.warn("openBrokerPriceStream failed", err);
      return { ok: false, reason: "broker-error" };
    }
  });

/** Tear a streaming context down when the page stops watching it. */
export const closeBrokerPriceStream = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ portfolioId: z.string().uuid(), contextId: z.string().min(1).max(64) }).parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    try {
      const { getBrokerPriceAdapter } = await import("@/lib/brokers/saxo-prices.server");
      const adapter = await getBrokerPriceAdapter(data.portfolioId);
      if (!adapter) return { ok: false };
      await adapter.closeStreamingContext(data.contextId);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
