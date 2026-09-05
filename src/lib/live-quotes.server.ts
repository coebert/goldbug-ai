// Real-time quote feed.
//
// Two sources, in preference order:
//  1. The broker's own tape (Saxo) — the prices our fills actually print
//     against, but it can only price instruments we can route (no indices, no
//     FX crosses, no unlisted pseudo-symbols).
//  2. A real-time public feed, batched in ONE request for the whole basket, so
//     indices, rates, commodities, FX and crypto all move on the dashboard.
//
// Unit convention matches `price_cache` (LSE lines quoted in pence), because
// both come off the same public tape.

import { toYahooSymbol } from "@/lib/market-data.server";
import { isBrokerRoutable } from "@/lib/brokers/saxo-prices.server";
import {
  EMPTY_LIVE_QUOTES,
  type LiveQuote,
  type LiveQuoteResult,
} from "@/lib/live-quotes";

const SPARK_URL = "https://query1.finance.yahoo.com/v7/finance/spark";
const CHUNK = 25;
const TIMEOUT_MS = 6_000;

type SparkMeta = {
  symbol?: string;
  regularMarketPrice?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  regularMarketChangePercent?: number;
  regularMarketTime?: number;
  currency?: string;
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchPublicChunk(symbols: string[]): Promise<Record<string, LiveQuote>> {
  const out: Record<string, LiveQuote> = {};
  if (symbols.length === 0) return out;
  // Yahoo keys the response by ITS symbol (GBPUSD=X), not ours (GBPUSD).
  const byFeedSymbol = new Map<string, string>();
  for (const s of symbols) byFeedSymbol.set(toYahooSymbol(s).toUpperCase(), s);

  const url = `${SPARK_URL}?symbols=${encodeURIComponent(
    [...byFeedSymbol.keys()].join(","),
  )}&range=1d&interval=5m`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const { runWithBreaker } = await import("@/lib/_server/provider-circuit");
    const body = await runWithBreaker("yahoo", async () => {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; LovableTrader/1.0)" },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`spark ${res.status}`);
      }
      return (await res.json()) as { spark?: { result?: Array<{ response?: Array<{ meta?: SparkMeta }> }> } };
    });

    for (const entry of body?.spark?.result ?? []) {
      const meta = entry?.response?.[0]?.meta;
      const feedSymbol = String(meta?.symbol ?? "").toUpperCase();
      const symbol = byFeedSymbol.get(feedSymbol);
      const price = Number(meta?.regularMarketPrice);
      if (!symbol || !Number.isFinite(price) || price <= 0) continue;
      const prev = Number(meta?.previousClose ?? meta?.chartPreviousClose);
      const pct = Number(meta?.regularMarketChangePercent);
      const ts = Number(meta?.regularMarketTime);
      out[symbol] = {
        symbol,
        price,
        previousClose: Number.isFinite(prev) && prev > 0 ? prev : null,
        changePct: Number.isFinite(pct) ? pct : null,
        currency: meta?.currency ?? null,
        at: new Date(Number.isFinite(ts) && ts > 0 ? ts * 1000 : Date.now()).toISOString(),
        source: "public",
      };
    }
  } catch (err) {
    console.warn("live-quotes: public feed unavailable", err);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/**
 * Live prices for a basket.
 *
 * Never throws: a dead feed degrades to "no ticks" and every caller keeps
 * showing the last close rather than a blank or a zero.
 */
export async function fetchLiveQuotes(
  symbols: string[],
  opts?: {
    /** Try the broker tape first for these (defaults to none). */
    preferBrokerFor?: string[];
    portfolioId?: string;
  },
): Promise<LiveQuoteResult> {
  const unique = [...new Set(symbols.map((s) => String(s ?? "").trim()).filter(Boolean))];
  if (unique.length === 0) return { ...EMPTY_LIVE_QUOTES };

  const quotes: Record<string, LiveQuote> = {};
  let fromBroker = 0;

  const brokerWanted = (opts?.preferBrokerFor ?? []).filter((s) => isBrokerRoutable(s));
  if (brokerWanted.length > 0) {
    try {
      const { fetchBrokerQuotes } = await import("@/lib/brokers/saxo-prices.server");
      const broker = await fetchBrokerQuotes(brokerWanted, { portfolioId: opts?.portfolioId });
      for (const [symbol, q] of Object.entries(broker)) {
        const price = Number(q?.price);
        if (!Number.isFinite(price) || price <= 0) continue;
        quotes[symbol] = {
          symbol,
          price,
          previousClose: null,
          changePct: null,
          currency: q?.currency ?? null,
          at: q?.at ?? new Date().toISOString(),
          source: "broker",
        };
        fromBroker += 1;
      }
    } catch (err) {
      console.warn("live-quotes: broker tape unavailable", err);
    }
  }

  // Everything the broker could not price — plus every index/rate/FX line,
  // which it never can — comes off the public real-time feed.
  const remaining = unique.filter((s) => !quotes[s]);
  for (const part of chunk(remaining, CHUNK)) {
    Object.assign(quotes, await fetchPublicChunk(part));
  }

  const times = Object.values(quotes).map((q) => q.at).sort();
  const covered = Object.keys(quotes).length;
  return {
    quotes,
    asOf: times[times.length - 1] ?? null,
    requested: unique.length,
    covered,
    fromBroker,
    stale: covered === 0,
  };
}
