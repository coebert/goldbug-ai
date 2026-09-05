import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type BrokerQuoteRow = {
  symbol: string;
  price: number;
  bid: number | null;
  ask: number | null;
  currency: string;
  at: string;
};

export type BrokerQuoteResult = {
  /** Keyed by the portfolio's own (broker-native) holding symbol. */
  quotes: Record<string, BrokerQuoteRow>;
  /** How many holdings could be priced live; the UI labels the source with it. */
  covered: number;
  requested: number;
  /** How many of those came from the broker's own tape rather than the public feed. */
  fromBroker: number;
  source: "broker" | "mixed" | "public" | "unavailable";
};

/**
 * Live quotes for a portfolio's open positions.
 *
 * The dashboard previously valued holdings off `price_cache` (a delayed daily
 * tape), so position value and unrealised P&L drifted from what the broker was
 * actually showing. The broker's own prices come first; anything it cannot
 * price (unroutable lines, a dropped session) falls back to a real-time public
 * feed rather than back to yesterday's close.
 */
export const getBrokerQuotes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ portfolioId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }): Promise<BrokerQuoteResult> => {
    const { data: holdings } = await context.supabase
      .from("holdings")
      .select("symbol, quantity")
      .eq("portfolio_id", data.portfolioId);
    const symbols = Array.from(
      new Set((holdings ?? []).filter((h) => Number(h.quantity) !== 0).map((h) => h.symbol)),
    );
    if (symbols.length === 0) {
      return { quotes: {}, covered: 0, requested: 0, fromBroker: 0, source: "unavailable" };
    }

    const quotes: Record<string, BrokerQuoteRow> = {};
    let fromBroker = 0;
    try {
      const { fetchBrokerQuotes } = await import("@/lib/brokers/saxo-prices.server");
      Object.assign(quotes, await fetchBrokerQuotes(symbols, { portfolioId: data.portfolioId }));
      fromBroker = Object.keys(quotes).length;
    } catch (err) {
      console.warn("getBrokerQuotes: broker feed unavailable", err);
    }

    // Public real-time feed for whatever is left. Holdings are broker-native
    // ("MKS:xlon"), the public tape is not — map through the engine key and
    // write the result back under the holding's own symbol.
    const missing = symbols.filter((s) => !quotes[s]);
    if (missing.length > 0) {
      try {
        const { engineSymbolKey } = await import("@/lib/price-symbol");
        const { fetchLiveQuotes } = await import("@/lib/live-quotes.server");
        const byPublic = new Map(missing.map((s) => [engineSymbolKey(s), s]));
        const live = await fetchLiveQuotes([...byPublic.keys()]);
        for (const [pub, q] of Object.entries(live.quotes)) {
          const holdingSymbol = byPublic.get(pub);
          if (!holdingSymbol) continue;
          quotes[holdingSymbol] = {
            symbol: holdingSymbol,
            price: q.price,
            bid: null,
            ask: null,
            currency: q.currency ?? "",
            at: q.at,
          };
        }
      } catch (err) {
        console.warn("getBrokerQuotes: public feed unavailable", err);
      }
    }

    const covered = Object.keys(quotes).length;
    return {
      quotes,
      covered,
      requested: symbols.length,
      fromBroker,
      source:
        covered === 0
          ? "unavailable"
          : fromBroker === covered
            ? "broker"
            : fromBroker === 0
              ? "public"
              : "mixed",
    };
  });

