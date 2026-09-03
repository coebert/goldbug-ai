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
  /** How many holdings the broker could price; the UI labels the source with it. */
  covered: number;
  requested: number;
  source: "broker" | "unavailable";
};

/**
 * Live Saxo quotes for a portfolio's open positions.
 *
 * The dashboard previously valued holdings off `price_cache` (a delayed public
 * tape), so position value and unrealised P&L drifted from what the broker was
 * actually showing. These are the venue's own prices.
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
      return { quotes: {}, covered: 0, requested: 0, source: "unavailable" };
    }
    try {
      const { fetchBrokerQuotes } = await import("@/lib/brokers/saxo-prices.server");
      const quotes = await fetchBrokerQuotes(symbols, { portfolioId: data.portfolioId });
      const covered = Object.keys(quotes).length;
      return {
        quotes,
        covered,
        requested: symbols.length,
        source: covered > 0 ? "broker" : "unavailable",
      };
    } catch (err) {
      console.warn("getBrokerQuotes: broker feed unavailable", err);
      return { quotes: {}, covered: 0, requested: symbols.length, source: "unavailable" };
    }
  });
