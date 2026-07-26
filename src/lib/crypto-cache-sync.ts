// Validation that the crypto ETP universe stays in sync with the
// `saxo_instrument_cache` table.
//
// The crypto sleeve has three sources of truth that MUST agree:
//
//   1. `CRYPTO_SYMBOL_MAP` in `src/lib/crypto-groups.ts` — the canonical
//      list of Saxo-tradable, physically-backed crypto ETPs.
//   2. The crypto entries in `UNIVERSE` (`src/lib/universe.server.ts`)
//      that carry `asset_class === "crypto"` and don't look like spot
//      pairs (`-USD`).
//   3. Rows in `saxo_instrument_cache` per broker env, whose `asset_type`
//      must be one of `CRYPTO_ALLOWED_SAXO_ASSET_TYPES` and whose
//      `refreshed_at` must be recent enough that the crypto validator
//      won't reject a fresh buy.
//
// Whenever `saxo.server.ts#lookupUic` upserts a cache row, we run this
// validator so any drift (a symbol added to the universe but never
// refreshed, a row cached under the wrong asset_type, or a stale row)
// surfaces as an audit-log warning instead of a silent trading block at
// the next tick.
//
// Kept in a client-safe module so tests + UI can import it without
// dragging the Supabase server client into the browser bundle.

import { CRYPTO_SYMBOL_MAP } from "./crypto-groups";
import { CRYPTO_ALLOWED_SAXO_ASSET_TYPES } from "./crypto-validation.server";

/** Max age before a cache row is considered stale for a fresh buy. */
export const CRYPTO_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Minimal cache-row shape this validator needs. Kept narrow so callers
 *  can pass either raw DB rows or hand-built fixtures. */
export type CryptoCacheRow = {
  symbol: string;
  env: string;
  asset_type: string | null;
  refreshed_at: string | null;
};

export type CryptoCacheDrift = {
  /** Approved ETPs with no cache row at all for the given env. */
  missing: string[];
  /** Cache rows whose `asset_type` isn't an allowed crypto type. */
  wrongAssetType: Array<{ symbol: string; assetType: string }>;
  /** Cache rows older than `CRYPTO_CACHE_MAX_AGE_MS`. */
  stale: Array<{ symbol: string; refreshedAt: string; ageMs: number }>;
  /** Rows in the cache whose symbol is NOT in the approved universe.
   *  Surfaces drift when someone renames or removes an ETP without
   *  clearing the cache. */
  unknown: Array<{ symbol: string; assetType: string | null }>;
};

export type CryptoCacheSyncReport = {
  env: string;
  approvedSymbols: string[];
  checkedAt: string;
  drift: CryptoCacheDrift;
  ok: boolean;
  summary: string;
};

/** Approved crypto ETPs — the single source of truth this validator
 *  compares the cache against. */
export function approvedCryptoEtps(): string[] {
  return Object.keys(CRYPTO_SYMBOL_MAP).sort();
}

/**
 * Compare a snapshot of `saxo_instrument_cache` rows (for a single env)
 * against the approved crypto universe. Pure function — no DB access,
 * so it can run inside unit tests and inside the broker's upsert hook.
 */
export function validateCryptoCacheSync(args: {
  env: string;
  cacheRows: readonly CryptoCacheRow[];
  now?: Date;
}): CryptoCacheSyncReport {
  const now = args.now ?? new Date();
  const approved = new Set(approvedCryptoEtps());
  const allowedTypes = new Set<string>(CRYPTO_ALLOWED_SAXO_ASSET_TYPES);

  // Filter rows to the requested env — the broker caches sim + live
  // separately and each must be validated against its own snapshot.
  const rows = args.cacheRows.filter((r) => r.env === args.env);

  const bySymbol = new Map<string, CryptoCacheRow>();
  for (const r of rows) bySymbol.set(r.symbol, r);

  const missing: string[] = [];
  for (const sym of approved) {
    if (!bySymbol.has(sym)) missing.push(sym);
  }
  missing.sort();

  const wrongAssetType: CryptoCacheDrift["wrongAssetType"] = [];
  const stale: CryptoCacheDrift["stale"] = [];
  const unknown: CryptoCacheDrift["unknown"] = [];

  for (const r of rows) {
    if (!approved.has(r.symbol)) {
      unknown.push({ symbol: r.symbol, assetType: r.asset_type });
      // Unknown rows still get asset-type / staleness checks skipped —
      // the approved-universe drift is the real signal.
      continue;
    }
    const assetType = String(r.asset_type ?? "");
    if (!allowedTypes.has(assetType)) {
      wrongAssetType.push({ symbol: r.symbol, assetType });
    }
    const refreshedAt = r.refreshed_at ? new Date(r.refreshed_at) : null;
    const ageMs = refreshedAt && !Number.isNaN(refreshedAt.getTime())
      ? now.getTime() - refreshedAt.getTime()
      : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(ageMs) || ageMs > CRYPTO_CACHE_MAX_AGE_MS) {
      stale.push({
        symbol: r.symbol,
        refreshedAt: r.refreshed_at ?? "never",
        ageMs: Number.isFinite(ageMs) ? ageMs : -1,
      });
    }
  }

  wrongAssetType.sort((a, b) => a.symbol.localeCompare(b.symbol));
  stale.sort((a, b) => a.symbol.localeCompare(b.symbol));
  unknown.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const drift: CryptoCacheDrift = { missing, wrongAssetType, stale, unknown };
  const ok =
    missing.length === 0 &&
    wrongAssetType.length === 0 &&
    stale.length === 0 &&
    unknown.length === 0;

  const parts: string[] = [];
  if (missing.length) parts.push(`missing=${missing.join(",")}`);
  if (wrongAssetType.length)
    parts.push(
      `wrongAssetType=${wrongAssetType.map((w) => `${w.symbol}:${w.assetType || "∅"}`).join(",")}`,
    );
  if (stale.length) parts.push(`stale=${stale.map((s) => s.symbol).join(",")}`);
  if (unknown.length) parts.push(`unknown=${unknown.map((u) => u.symbol).join(",")}`);
  const summary = ok
    ? `crypto cache in sync (${approved.size} approved ETPs, env=${args.env})`
    : `crypto cache drift for env=${args.env}: ${parts.join("; ")}`;

  return {
    env: args.env,
    approvedSymbols: [...approved].sort(),
    checkedAt: now.toISOString(),
    drift,
    ok,
    summary,
  };
}

/** True when the given symbol is one of the approved crypto ETPs and
 *  therefore worth triggering a sync check after a cache upsert. */
export function isApprovedCryptoEtp(symbol: string): boolean {
  return approvedCryptoEtps().includes(symbol);
}
