// Lightweight FX conversion. Server-only.
// Used by the live executor to record the notional value of routed orders
// in the broker account currency (e.g. Saxo SIM base = EUR) when the
// portfolio's own accounting currency differs (e.g. GBP), and by the
// multi-currency wallet/holdings valuation layer.
//
// Provider order:
//   1. Frankfurter (ECB reference rates, keyless, no rate limit) — primary.
//      Yahoo's /v7/finance/quote endpoint started returning 401s to
//      unauthenticated clients, causing the executor to fall back to the
//      identity rate (1.0) and silently break cross-currency sizing.
//   2. open.er-api.com (keyless mirror of ECB + commercial feeds) — fallback
//      so a Frankfurter outage doesn't collapse to rate=1.
//   3. Last-known cached rate marked stale, else identity fallback flagged
//      so the FX-matrix guard blocks affected buys instead of silently
//      trading on a bogus rate.
//
// Cached in-memory for 10 minutes per process.

type Cached = { rate: number; ts: number };
const cache = new Map<string, Cached>();
const TTL_MS = 10 * 60 * 1000;

async function closeBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Best-effort cleanup only.
  }
}

export interface FxResult {
  from: string;
  to: string;
  rate: number;
  stale: boolean;
  source: string;
}

async function fetchFrankfurter(f: string, t: string): Promise<number> {
  const url = `https://api.frankfurter.dev/v1/latest?base=${f}&symbols=${t}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    await closeBody(res);
    throw new Error(`frankfurter ${res.status}`);
  }
  const json = (await res.json()) as { rates?: Record<string, number> };
  const rate = json?.rates?.[t];
  if (typeof rate !== "number" || !(rate > 0) || !Number.isFinite(rate)) {
    throw new Error("no rate in frankfurter response");
  }
  return rate;
}

async function fetchErApi(f: string, t: string): Promise<number> {
  const url = `https://open.er-api.com/v6/latest/${f}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    await closeBody(res);
    throw new Error(`er-api ${res.status}`);
  }
  const json = (await res.json()) as { result?: string; rates?: Record<string, number> };
  if (json?.result && json.result !== "success") {
    throw new Error(`er-api result=${json.result}`);
  }
  const rate = json?.rates?.[t];
  if (typeof rate !== "number" || !(rate > 0) || !Number.isFinite(rate)) {
    throw new Error("no rate in er-api response");
  }
  return rate;
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

  let frankfurterErr: unknown;
  try {
    const rate = await fetchFrankfurter(f, t);
    cache.set(key, { rate, ts: now });
    return { from: f, to: t, rate, stale: false, source: "frankfurter" };
  } catch (e) {
    frankfurterErr = e;
  }

  let erApiErr: unknown;
  try {
    const rate = await fetchErApi(f, t);
    cache.set(key, { rate, ts: now });
    return { from: f, to: t, rate, stale: false, source: "er-api" };
  } catch (e) {
    erApiErr = e;
  }

  if (cached) {
    return { from: f, to: t, rate: cached.rate, stale: true, source: "cache-stale" };
  }
  const fMsg = frankfurterErr instanceof Error ? frankfurterErr.message : "frankfurter-error";
  const eMsg = erApiErr instanceof Error ? erApiErr.message : "er-api-error";
  return {
    from: f,
    to: t,
    rate: 1,
    stale: true,
    source: `fallback:frankfurter(${fMsg})+er-api(${eMsg})`,
  };
}

/**
 * Same as `getFxRate` but also returns the observation timestamp of the
 * underlying rate (cache entry timestamp when the answer came from cache /
 * cache-stale, otherwise the moment of the successful live fetch). Used by
 * the FX audit surface so operators can see exactly *when* the rate that
 * sizing is about to use was captured, not just its provenance.
 */
export interface FxAuditedResult extends FxResult {
  /** Epoch ms of the underlying observation. */
  observedAtMs: number;
}

export async function getFxRateAudited(from: string, to: string): Promise<FxAuditedResult> {
  const before = Date.now();
  const res = await getFxRate(from, to);
  const key = `${res.from}${res.to}`;
  const cached = cache.get(key);
  let observedAtMs = before;
  if (res.source === "identity") observedAtMs = before;
  else if (res.source === "cache" || res.source === "cache-stale") {
    observedAtMs = cached?.ts ?? before;
  } else if (res.source === "frankfurter" || res.source === "er-api") {
    observedAtMs = cached?.ts ?? Date.now();
  } else {
    // fallback:* — no valid observation
    observedAtMs = Date.now();
  }
  return { ...res, observedAtMs };
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

/**
 * Force a fresh fetch for the given pairs, bypassing the in-memory TTL cache.
 * Used by the pre-trade FX-matrix guard's refresh-and-retry flow: when a
 * batch is blocked because a rate is stale/missing/identity-fallback, we
 * evict those entries and re-query the live providers before deciding
 * whether to actually skip the affected buys. If providers are still down
 * the returned entries stay stale/fallback and the guard blocks again on
 * the second pass — deterministic and audit-friendly.
 */
export async function refreshFxMatrix(
  pairs: Array<{ from: string; to: string }>,
): Promise<Map<string, FxResult>> {
  for (const p of pairs) {
    cache.delete(`${p.from.toUpperCase()}${p.to.toUpperCase()}`);
  }
  return getFxMatrix(pairs);
}

// Test-only: reset the in-memory cache between tests to keep them isolated.
export function __resetFxCacheForTests() {
  cache.clear();
}
