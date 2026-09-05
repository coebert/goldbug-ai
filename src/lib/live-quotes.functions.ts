import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { EMPTY_LIVE_QUOTES, type LiveQuoteResult } from "@/lib/live-quotes";

const Input = z
  .object({
    /** Omit to price the whole market-pulse basket. */
    symbols: z.array(z.string().min(1).max(24)).max(120).optional(),
    /** Route these through the broker tape first (held positions). */
    preferBrokerFor: z.array(z.string().min(1).max(24)).max(120).optional(),
    portfolioId: z.string().uuid().optional(),
  })
  .default({});

/**
 * Real-time prices for the dashboard.
 *
 * Polled by the UI on a short interval, so it must stay cheap and must never
 * throw: on any feed failure it returns "no ticks" and the caller keeps the
 * last close.
 */
export const getLiveQuotes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => Input.parse(input ?? {}))
  .handler(async ({ data, context }): Promise<LiveQuoteResult> => {
    try {
      const { PULSE_SYMBOLS } = await import("./market-pulse");
      const symbols = data.symbols?.length ? data.symbols : PULSE_SYMBOLS;
      const { fetchLiveQuotes } = await import("./live-quotes.server");
      const result = await fetchLiveQuotes(symbols, {
        preferBrokerFor: data.preferBrokerFor ?? [],
        portfolioId: data.portfolioId,
      });

      // Keep the hourly tape fed: these are real observations, and they are
      // what the intraday sparklines are drawn from.
      if (result.covered > 0) {
        const { recordIntradayPrices } = await import("./price-intraday.server");
        await recordIntradayPrices(
          context.supabase as never,
          Object.values(result.quotes).map((q) => ({ symbol: q.symbol, price: q.price })),
          new Date(),
          "live_feed",
        );
      }
      return result;
    } catch (err) {
      console.warn("getLiveQuotes failed", err);
      return { ...EMPTY_LIVE_QUOTES };
    }
  });
