// Shared types + pure merge logic for the real-time quote feed.
//
// `price_cache` is a DAILY tape: every dashboard number derived from it is
// frozen at the last close, so the home screen looked static all session even
// while markets moved. The live feed re-prices those same instruments from a
// real-time source and this module folds the result back into the already
// computed pulse, so the tone/breadth/spark logic has exactly one
// implementation.

import {
  computeBreadth,
  computeTone,
  type MarketPulse,
  type PulseQuote,
} from "@/lib/market-pulse";

export type QuoteSource = "broker" | "public";

export interface LiveQuote {
  symbol: string;
  /** Last traded price, in the same unit convention as `price_cache`. */
  price: number;
  /** Official previous close, when the feed publishes one. */
  previousClose: number | null;
  /** Day change from the feed itself; preferred over a derived figure. */
  changePct: number | null;
  currency: string | null;
  /** ISO timestamp of the tick. */
  at: string;
  source: QuoteSource;
}

export interface LiveQuoteResult {
  quotes: Record<string, LiveQuote>;
  /** Newest tick timestamp across the basket. */
  asOf: string | null;
  requested: number;
  covered: number;
  fromBroker: number;
  /** True when nothing could be priced — the UI then keeps the daily close. */
  stale: boolean;
}

export const EMPTY_LIVE_QUOTES: LiveQuoteResult = {
  quotes: {},
  asOf: null,
  requested: 0,
  covered: 0,
  fromBroker: 0,
  stale: true,
};

/** A quote is only usable if it is a positive, finite price. */
export function isUsableQuote(q: LiveQuote | undefined | null): q is LiveQuote {
  return !!q && Number.isFinite(q.price) && q.price > 0;
}

/**
 * Re-price one pulse row off a live tick.
 *
 * Multi-day moves are rescaled rather than recomputed: the daily series still
 * owns the historical leg, and the live tick only shifts where "today" sits,
 * so `newPct = ((1 + oldPct) * price / lastClose) - 1`. The 1-day move comes
 * straight from the feed's own previous close whenever it publishes one, which
 * keeps it correct across dividends, splits and stale cache rows alike.
 */
export function repriceQuote(quote: PulseQuote, live: LiveQuote): PulseQuote {
  if (!isUsableQuote(live) || !(quote.close > 0)) return quote;
  const shift = live.price / quote.close;
  if (!Number.isFinite(shift) || shift <= 0) return quote;

  const rescale = (pct: number | null): number | null =>
    pct == null ? null : ((1 + pct / 100) * shift - 1) * 100;

  // Same session already in the cache? Then the cached row IS today, and its
  // own prior close is the right base — do not chain today's move twice.
  const sameSession = live.at.slice(0, 10) === quote.asOf;
  const feedPct =
    live.changePct != null && Number.isFinite(live.changePct)
      ? live.changePct
      : live.previousClose && live.previousClose > 0
        ? (live.price / live.previousClose - 1) * 100
        : null;

  const changePct1d = feedPct ?? (sameSession ? quote.changePct1d : rescale(quote.changePct1d));
  const sma50 =
    quote.vsSma50Pct != null && quote.vsSma50Pct !== -100
      ? quote.close / (1 + quote.vsSma50Pct / 100)
      : null;

  const spark = [...quote.spark];
  const liveDay = live.at.slice(0, 10);
  if (spark.length && spark[spark.length - 1]!.date === liveDay) {
    spark[spark.length - 1] = { date: liveDay, value: live.price };
  } else {
    spark.push({ date: liveDay, value: live.price });
  }

  return {
    ...quote,
    close: live.price,
    asOf: liveDay,
    changePct1d,
    changePct5d: sameSession ? quote.changePct5d : rescale(quote.changePct5d),
    changePct1m: sameSession ? quote.changePct1m : rescale(quote.changePct1m),
    changePct3m: sameSession ? quote.changePct3m : rescale(quote.changePct3m),
    vsSma50Pct: sma50 && sma50 > 0 ? ((live.price - sma50) / sma50) * 100 : quote.vsSma50Pct,
    aboveSma50: sma50 && sma50 > 0 ? live.price > sma50 : quote.aboveSma50,
    spark,
  };
}

/**
 * Fold live ticks into a computed pulse: re-price every row we have a tick
 * for, then recompute breadth and the risk tone off the refreshed numbers so
 * the headline can never disagree with the rows beneath it.
 */
export function applyLiveQuotes<T extends MarketPulse>(pulse: T, live: LiveQuoteResult | null): T {
  if (!live || live.covered === 0) return pulse;
  const tick = (q: PulseQuote) => {
    const l = live.quotes[q.symbol];
    return isUsableQuote(l) ? repriceQuote(q, l) : q;
  };
  const quotes = pulse.quotes.map(tick);
  const sectors = pulse.sectors.map(tick);
  const breadthUniverse = [...quotes.filter((q) => q.group !== "volatility"), ...sectors];
  const breadth = computeBreadth(breadthUniverse);
  const { tone, score, reasons } = computeTone(quotes, sectors, breadth);
  return {
    ...pulse,
    quotes,
    sectors,
    breadth,
    tone,
    toneScore: score,
    toneReasons: reasons,
    asOf: [...quotes, ...sectors].map((q) => q.asOf).sort().slice(-1)[0] ?? pulse.asOf,
  };
}
