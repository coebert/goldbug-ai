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
  | { ok: true; contextId: string; wsUrl: string; symbols: string[] }
  | { ok: false; reason: string };

export type BrokerStreamSubscribeResult =
  | { ok: true; inactivityTimeoutSec: number; subscriptions: BrokerStreamSubscription[] }
  | { ok: false; reason: string };

const portfolioInput = z.object({ portfolioId: z.string().uuid() });

/**
 * Broker-routable symbols with an open position, or null when the portfolio
 * isn't visible to the caller.
 */
async function routableSymbols(
  supabase: { from: (t: string) => any },
  portfolioId: string,
): Promise<string[] | null> {
  const { data: portfolio } = await supabase
    .from("portfolios")
    .select("id")
    .eq("id", portfolioId)
    .maybeSingle();
  if (!portfolio) return null;
  const { data: holdings } = await supabase
    .from("holdings")
    .select("symbol, quantity")
    .eq("portfolio_id", portfolioId);
  const { isBrokerRoutable } = await import("@/lib/brokers/saxo-prices.server");
  return Array.from(
    new Set(
      (holdings ?? [])
        .filter((h: { quantity: number }) => Number(h.quantity) !== 0)
        .map((h: { symbol: string }) => String(h.symbol))
        .filter(isBrokerRoutable),
    ),
  );
}

/**
 * Phase 1 of the price stream: mint a streaming context and hand back the
 * connect URL.
 *
 * Subscriptions are deliberately NOT created here. Saxo pushes deltas to an
 * already-connected socket; when the subscription is created first, the
 * initial burst has nowhere to land and the page shows a connected socket that
 * never ticks — exactly the "green badge, frozen prices" failure. The page
 * connects first, then calls `subscribeBrokerPrices` on the same context.
 *
 * The connect URL embeds the broker token. It is handed only to the
 * authenticated owner of the account, and the page keeps it in memory.
 */
export const openBrokerPriceStream = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => portfolioInput.parse(input))
  .handler(async ({ data, context }): Promise<BrokerStreamSession> => {
    const symbols = await routableSymbols(context.supabase as never, data.portfolioId);
    if (symbols == null) return { ok: false, reason: "not-found" };
    if (symbols.length === 0) return { ok: false, reason: "no-positions" };
    try {
      const { getBrokerPriceAdapter } = await import("@/lib/brokers/saxo-prices.server");
      const adapter = await getBrokerPriceAdapter(data.portfolioId);
      if (!adapter) return { ok: false, reason: "no-broker" };
      const contextId = adapter.newStreamingContextId();
      return { ok: true, contextId, wsUrl: adapter.buildStreamingUrl(contextId), symbols };
    } catch (err) {
      console.warn("openBrokerPriceStream failed", err);
      return { ok: false, reason: "broker-error" };
    }
  });

/** Phase 2: create the price subscriptions once the socket is open. */
export const subscribeBrokerPrices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    portfolioInput.extend({ contextId: z.string().min(1).max(64) }).parse(input),
  )
  .handler(async ({ data, context }): Promise<BrokerStreamSubscribeResult> => {
    const symbols = await routableSymbols(context.supabase as never, data.portfolioId);
    if (symbols == null) return { ok: false, reason: "not-found" };
    if (symbols.length === 0) return { ok: false, reason: "no-positions" };
    try {
      const { getBrokerPriceAdapter } = await import("@/lib/brokers/saxo-prices.server");
      const adapter = await getBrokerPriceAdapter(data.portfolioId);
      if (!adapter) return { ok: false, reason: "no-broker" };
      const res = await adapter.createInfoPriceSubscriptions(data.contextId, symbols);
      if (res.subscriptions.length === 0) {
        await adapter.closeStreamingContext(data.contextId);
        return { ok: false, reason: "no-quotable-positions" };
      }
      return {
        ok: true,
        inactivityTimeoutSec: res.inactivityTimeoutSec,
        subscriptions: res.subscriptions,
      };
    } catch (err) {
      console.warn("subscribeBrokerPrices failed", err);
      return { ok: false, reason: "broker-error" };
    }
  });

/** Tear a streaming context down when the page stops watching it. */
export const closeBrokerPriceStream = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    portfolioInput.extend({ contextId: z.string().min(1).max(64) }).parse(input),
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
