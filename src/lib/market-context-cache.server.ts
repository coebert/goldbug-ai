// Phase 7 — Shared market-context cache with 1-hour TTL.
//
// When the hourly cron ticks N paper portfolios back-to-back, they all need the
// same slow bits: news + LLM sentiment scoring, macro regime, cross-asset
// snapshot, options-implied signals, cross-sectional feature rows for the
// candidate universe. Recomputing them per portfolio wastes gateway credits
// and Yahoo Finance requests. This module memoises those results in-process
// for 1 hour, keyed by (asOf date, hour bucket, cache-key).
//
// Portfolio-specific bits (learning, cooldowns, attribution, hyperparams,
// holdings) are NOT cached here — they still run per portfolio inside the
// tick.
//
// The cache lives in module scope, so it survives across `runDailyTick`
// calls within the same worker instance for the same hour. A new hour, a
// new asOf date, or a worker restart invalidates entries.

const TTL_MS = 60 * 60 * 1000; // 1 hour

type Entry<T> = { expires: number; value: T };

const store = new Map<string, Entry<unknown>>();

function hourBucket(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`;
}

export async function cached<T>(
  namespace: string,
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  const fullKey = `${namespace}:${hourBucket()}:${key}`;
  const now = Date.now();
  const hit = store.get(fullKey) as Entry<T> | undefined;
  if (hit && hit.expires > now) return hit.value;
  const value = await loader();
  store.set(fullKey, { expires: now + TTL_MS, value });
  // Opportunistic pruning to keep the map bounded
  if (store.size > 256) {
    for (const [k, v] of store) if (v.expires <= now) store.delete(k);
  }
  return value;
}

export function invalidateContextCache() {
  store.clear();
}

export function contextCacheStats() {
  return { size: store.size, bucket: hourBucket() };
}
