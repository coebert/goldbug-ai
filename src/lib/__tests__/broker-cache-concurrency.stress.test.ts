// Concurrency stress test for broker-cache upserts + crypto-universe sync.
//
// Simulates many parallel `lookupUic`-style operations against a shared
// in-memory stand-in for `saxo_instrument_cache`, with the crypto sync
// validator running after every upsert (mirroring the production hook in
// `src/lib/brokers/saxo.server.ts`).
//
// Verifies, under contention:
//   - upserts stay unique on (symbol, env) — no duplicate rows leak in
//   - env isolation holds (sim vs live never cross-write)
//   - asset_type stays consistent for every approved ETP
//   - refreshed_at is monotonic per symbol (later winner wins, no rewind)
//   - `validateCryptoCacheSync` returns ok=true once the storm settles,
//     regardless of ordering
//   - a validator running concurrently with an upsert never crashes on
//     a partial snapshot (best-effort log path stays crash-free)

import { describe, it, expect } from "vitest";
import {
  validateCryptoCacheSync,
  approvedCryptoEtps,
  type CryptoCacheRow,
} from "../crypto-cache-sync";
import { CRYPTO_ALLOWED_SAXO_ASSET_TYPES } from "../crypto-validation.server";

// -------- in-memory cache simulating `saxo_instrument_cache` -------------

type Row = CryptoCacheRow & { uic: number };
const KEY = (env: string, sym: string) => `${env}::${sym}`;

class CacheStore {
  private map = new Map<string, Row>();
  // Serialise writes for the same (env, symbol) to model the DB's
  // per-row atomicity of `upsert on conflict`.
  private locks = new Map<string, Promise<void>>();

  async upsert(row: Row): Promise<void> {
    const k = KEY(row.env, row.symbol);
    const prev = this.locks.get(k) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    this.locks.set(k, prev.then(() => gate));
    await prev;
    try {
      // Simulate a small write latency so parallelism actually interleaves.
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      const existing = this.map.get(k);
      // "onConflict: symbol,env" semantics: later refreshed_at wins.
      if (!existing || existing.refreshed_at! < row.refreshed_at!) {
        this.map.set(k, row);
      }
    } finally {
      release();
    }
  }

  snapshotByEnv(env: string): CryptoCacheRow[] {
    // Callers filter by env; return a defensive shallow copy so a validator
    // running concurrently with writes sees a stable list.
    return Array.from(this.map.values())
      .filter((r) => r.env === env)
      .map((r) => ({ ...r }));
  }

  size(): number {
    return this.map.size;
  }
}

// Realistic per-symbol payload (asset_type comes from the allowed set).
const APPROVED = approvedCryptoEtps();
const ASSET_TYPE_FOR: Record<string, string> = {
  "BTCE.DE": "Etn",
  "ABTC.SW": "Etp",
  "BTCW.L":  "Etc",
  "ZETH.SW": "Etp",
  "ZETH.DE": "Etn",
  "HODL.SW": "Etp",
};

async function fakeLookupUic(
  store: CacheStore,
  env: string,
  symbol: string,
  refreshedAt: string,
): Promise<{ report: ReturnType<typeof validateCryptoCacheSync> }> {
  await store.upsert({
    env,
    symbol,
    uic: Math.abs(hash(env + symbol)) % 1_000_000,
    asset_type: ASSET_TYPE_FOR[symbol] ?? "Etp",
    refreshed_at: refreshedAt,
  });
  // Best-effort validator — production wraps this in try/catch and never
  // blocks the order. Here we return the report so the test can assert.
  const snap = store.snapshotByEnv(env);
  const report = validateCryptoCacheSync({ env, cacheRows: snap });
  return { report };
}

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return h | 0;
}

// -------- tests ---------------------------------------------------------

describe("broker cache concurrency stress", () => {
  it("parallel refreshes leave exactly one row per (symbol, env), no duplicates", async () => {
    const store = new CacheStore();
    const now = Date.now();

    // 6 ETPs × 2 envs × 25 concurrent refreshes = 300 upserts.
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 25; i++) {
      for (const env of ["sim", "live"]) {
        for (const sym of APPROVED) {
          // Stagger refreshed_at monotonically so we can also assert "latest wins".
          const ts = new Date(now + i * 1000 + Math.floor(Math.random() * 100)).toISOString();
          ops.push(fakeLookupUic(store, env, sym, ts));
        }
      }
    }
    await Promise.all(ops);

    // Exactly 6 approved symbols per env.
    expect(store.snapshotByEnv("sim")).toHaveLength(APPROVED.length);
    expect(store.snapshotByEnv("live")).toHaveLength(APPROVED.length);
    expect(store.size()).toBe(APPROVED.length * 2);

    // Env isolation: sim rows never appear when querying live.
    for (const r of store.snapshotByEnv("sim")) expect(r.env).toBe("sim");
    for (const r of store.snapshotByEnv("live")) expect(r.env).toBe("live");
  });

  it("under contention the crypto sync validator eventually reports ok for both envs", async () => {
    const store = new CacheStore();
    const now = Date.now();
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      for (const env of ["sim", "live"]) {
        for (const sym of APPROVED) {
          ops.push(fakeLookupUic(store, env, sym, new Date(now + i * 500).toISOString()));
        }
      }
    }
    const results = await Promise.all(ops);

    // At least one intermediate report may be non-ok (missing symbols during
    // the first pass) — that's fine. The final steady-state must be clean
    // for BOTH envs.
    for (const env of ["sim", "live"]) {
      const finalReport = validateCryptoCacheSync({ env, cacheRows: store.snapshotByEnv(env) });
      expect(finalReport.ok).toBe(true);
      expect(finalReport.drift.missing).toEqual([]);
      expect(finalReport.drift.wrongAssetType).toEqual([]);
      expect(finalReport.drift.stale).toEqual([]);
      expect(finalReport.drift.unknown).toEqual([]);
    }
    // Best-effort validator never crashes: every op returned a report.
    for (const r of results) expect((r as { report: unknown }).report).toBeTruthy();
  });

  it("refreshed_at is monotonic per (symbol, env) — later timestamps always win", async () => {
    const store = new CacheStore();
    const now = Date.now();
    const ops: Promise<unknown>[] = [];
    // Generate a shuffled sequence of (timestamp, symbol, env) triples,
    // then fire them all in parallel. The store should still end up with
    // the maximum timestamp per (symbol, env).
    const maxTs: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      for (const env of ["sim", "live"]) {
        for (const sym of APPROVED) {
          const ts = new Date(now + i * 1000).toISOString();
          const k = KEY(env, sym);
          if (!maxTs[k] || maxTs[k] < ts) maxTs[k] = ts;
          ops.push(fakeLookupUic(store, env, sym, ts));
        }
      }
    }
    // Shuffle the fire order.
    for (let i = ops.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ops[i], ops[j]] = [ops[j], ops[i]];
    }
    await Promise.all(ops);

    for (const env of ["sim", "live"]) {
      for (const row of store.snapshotByEnv(env)) {
        expect(row.refreshed_at).toBe(maxTs[KEY(env, row.symbol)]);
        expect(
          (CRYPTO_ALLOWED_SAXO_ASSET_TYPES as readonly string[]).includes(row.asset_type ?? ""),
        ).toBe(true);
      }
    }
  });

  it("validator running concurrently with upserts never observes an inconsistent row shape", async () => {
    const store = new CacheStore();
    const now = Date.now();

    // Kick off a wave of upserts.
    const writers: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      for (const env of ["sim", "live"]) {
        for (const sym of APPROVED) {
          writers.push(
            fakeLookupUic(store, env, sym, new Date(now + i * 200).toISOString()),
          );
        }
      }
    }

    // Simultaneously fire off 200 validator reads at random times.
    const readers: Promise<void>[] = [];
    for (let i = 0; i < 200; i++) {
      readers.push((async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 20));
        for (const env of ["sim", "live"]) {
          const rep = validateCryptoCacheSync({ env, cacheRows: store.snapshotByEnv(env) });
          // Structural invariants that must hold on every read, mid-storm:
          //  - approvedSymbols always the full set
          //  - drift arrays always defined
          //  - env correctly echoed
          //  - every "missing" and "wrongAssetType" entry is in the approved list
          expect(rep.env).toBe(env);
          expect(rep.approvedSymbols).toEqual(APPROVED);
          expect(Array.isArray(rep.drift.missing)).toBe(true);
          expect(Array.isArray(rep.drift.wrongAssetType)).toBe(true);
          expect(Array.isArray(rep.drift.stale)).toBe(true);
          expect(Array.isArray(rep.drift.unknown)).toBe(true);
          for (const m of rep.drift.missing) expect(APPROVED).toContain(m);
          for (const w of rep.drift.wrongAssetType) expect(APPROVED).toContain(w.symbol);
        }
      })());
    }

    await Promise.all([...writers, ...readers]);

    // Final steady state clean for both envs.
    for (const env of ["sim", "live"]) {
      const rep = validateCryptoCacheSync({ env, cacheRows: store.snapshotByEnv(env) });
      expect(rep.ok).toBe(true);
    }
  });

  it("stale rows for approved symbols are always flagged, even when interleaved with fresh writes", async () => {
    const store = new CacheStore();
    const oldTs = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days old
    // Seed all 6 symbols as stale in `sim`.
    for (const sym of APPROVED) {
      await store.upsert({
        env: "sim", symbol: sym, uic: 1,
        asset_type: ASSET_TYPE_FOR[sym], refreshed_at: oldTs,
      });
    }
    // Concurrently refresh three of them; leave three stale.
    const refreshOps = APPROVED.slice(0, 3).map((sym) =>
      fakeLookupUic(store, "sim", sym, new Date().toISOString()),
    );
    await Promise.all(refreshOps);

    const rep = validateCryptoCacheSync({ env: "sim", cacheRows: store.snapshotByEnv("sim") });
    expect(rep.ok).toBe(false);
    const staleSyms = new Set(rep.drift.stale.map((s) => s.symbol));
    for (const sym of APPROVED.slice(3)) expect(staleSyms.has(sym)).toBe(true);
    for (const sym of APPROVED.slice(0, 3)) expect(staleSyms.has(sym)).toBe(false);
  });
});
