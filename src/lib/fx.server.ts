// Lightweight FX conversion via Yahoo Finance. Server-only.
// Used by the live executor to record the notional value of routed orders
// in the broker account currency (e.g. Saxo SIM base = EUR) when the
// portfolio's own accounting currency differs (e.g. GBP).
//
// Cached in-memory for 10 minutes per process. Failures fall back to rate = 1
// with `stale: true` so the caller can note it in the log without blocking
// order routing.

type Cached = { rate: number; ts: number };
const cache = new Map<string, Cached>();
const TTL_MS = 10 * 60 * 1000;

export interface FxResult {
  from: string;
  to: string;
  rate: number;
  stale: boolean;
  source: string;
}

/** Return the multiplier: amount_in_FROM * rate = amount_in_TO. */
export async function getFxRate(from: string, to: string): Promise<FxResult> {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return { from: f, to: t, rate: 1, stale: false, source: "identity" };

  const key = `${f}${t}`;
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && now - cached.ts < TTL_MS) {
    return { from: f, to: t, rate: cached.rate, stale: false, source: "cache" };
  }

  // Yahoo Finance FX symbol format: e.g. "GBPEUR=X"
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${key}=X`;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (aegis-fx)" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`yahoo ${res.status}`);
    const json = (await res.json()) as {
      quoteResponse?: { result?: Array<{ regularMarketPrice?: number }> };
    };
    const rate = json?.quoteResponse?.result?.[0]?.regularMarketPrice;
    if (typeof rate === "number" && rate > 0 && Number.isFinite(rate)) {
      cache.set(key, { rate, ts: now });
      return { from: f, to: t, rate, stale: false, source: "yahoo" };
    }
    throw new Error("no rate in response");
  } catch (err) {
    if (cached) {
      return { from: f, to: t, rate: cached.rate, stale: true, source: "cache-stale" };
    }
    return {
      from: f,
      to: t,
      rate: 1,
      stale: true,
      source: `fallback:${err instanceof Error ? err.message : "error"}`,
    };
  }
}

/** Convenience: convert an amount. */
export async function convertAmount(amount: number, from: string, to: string): Promise<{
  amount: number;
  fx: FxResult;
}> {
  const fx = await getFxRate(from, to);
  return { amount: amount * fx.rate, fx };
}
