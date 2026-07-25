// Lightweight FX conversion via Yahoo Finance. Server-only.
// Used by the live executor to record the notional value of routed orders
// in the broker account currency (e.g. Saxo SIM base = EUR) when the
// portfolio's own accounting currency differs (e.g. GBP), and by the
// multi-currency wallet/holdings valuation layer.
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

  const yahooUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${key}=X`;
  try {
    const res = await fetch(yahooUrl, {
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
  } catch (yahooErr) {
    try {
      const fUrl = `https://api.frankfurter.dev/v1/latest?base=${f}&symbols=${t}`;
      const res = await fetch(fUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`frankfurter ${res.status}`);
      const json = (await res.json()) as { rates?: Record<string, number> };
      const rate = json?.rates?.[t];
      if (typeof rate === "number" && rate > 0 && Number.isFinite(rate)) {
        cache.set(key, { rate, ts: now });
        return { from: f, to: t, rate, stale: false, source: "frankfurter" };
      }
      throw new Error("no rate in frankfurter response");
    } catch (frankfurterErr) {
      if (cached) {
        return { from: f, to: t, rate: cached.rate, stale: true, source: "cache-stale" };
      }
      const yMsg = yahooErr instanceof Error ? yahooErr.message : "yahoo-error";
      const fMsg = frankfurterErr instanceof Error ? frankfurterErr.message : "frankfurter-error";
      return {
        from: f,
        to: t,
        rate: 1,
        stale: true,
        source: `fallback:yahoo(${yMsg})+frankfurter(${fMsg})`,
      };
    }
  }
}

/** Convenience: convert an amount using the live/cached rate. */
export async function convertAmount(amount: number, from: string, to: string): Promise<{
  amount: number;
  fx: FxResult;
}> {
  const fx = await getFxRate(from, to);
  return { amount: amount * fx.rate, fx };
}

/**
 * Fetch many rates in parallel, deduplicating identical pairs. Used by the
 * multi-currency valuation layer where a portfolio may hold positions across
 * several currencies and we want one round-trip per unique pair (not per
 * holding). Returns a keyed map `${FROM}${TO} -> FxResult`.
 */
export async function getFxMatrix(
  pairs: Array<{ from: string; to: string }>,
): Promise<Map<string, FxResult>> {
  const unique = new Map<string, { from: string; to: string }>();
  for (const p of pairs) {
    const f = p.from.toUpperCase();
    const t = p.to.toUpperCase();
    unique.set(`${f}${t}`, { from: f, to: t });
  }
  const entries = await Promise.all(
    [...unique.values()].map(async (p) => {
      const fx = await getFxRate(p.from, p.to);
      return [`${p.from}${p.to}`, fx] as const;
    }),
  );
  return new Map(entries);
}

// Test-only: reset the in-memory cache between tests to keep them isolated.
export function __resetFxCacheForTests() {
  cache.clear();
}
