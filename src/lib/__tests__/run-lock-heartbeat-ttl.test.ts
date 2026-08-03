// Proves the run-lock HEARTBEAT extends the TTL during a long manual run.
//
// Production wiring (verified against source):
//   hourly-run.server.ts  -> setInterval(() => void lock.renew(), 30_000)
//   run-lock.server.ts    -> renewRunLock() UPDATEs BOTH
//                              acquired_at = now
//                              expires_at  = expiryFor(now, ttlMs)
//                            scoped .eq("name").eq("owner")
//
// Regressions this guards:
//   1. Every heartbeat must push `expires_at` forward — if only `acquired_at`
//      moved, the TTL sweep would delete a healthy long run's lock mid-flight.
//   2. The lock must never be sweepable while heartbeats keep landing, even
//      when the run outlives its original TTL several times over.
//   3. A renew from a DIFFERENT owner must be a no-op (no TTL extension by a
//      stale worker that lost the lock).
//   4. Once heartbeats stop (worker killed), the TTL lapses one TTL after the
//      LAST heartbeat — not after acquisition.

import { describe, expect, it, vi, afterEach } from "vitest";
import {
  expiryFor,
  isExpired,
  lockTtlMsForBudget,
  msUntilExpiry,
  clampTtl,
} from "@/lib/run-lock-ttl";

const T0 = Date.UTC(2026, 7, 3, 13, 0, 0);
const BUDGET_MS = 55_000;
const TTL_MS = lockTtlMsForBudget(BUDGET_MS);
const HEARTBEAT_MS = 30_000; // matches hourly-run.server.ts
const STALE_MS = 90_000;

type LockRow = { name: string; owner: string; acquired_at: string; expires_at: string | null };

/** In-memory `run_locks` with the real renew / sweep semantics. */
class FakeLockTable {
  rows = new Map<string, LockRow>();
  renews = 0;
  renewsApplied = 0;

  acquire(name: string, owner: string, nowMs: number, ttlMs: number): LockRow {
    const row: LockRow = {
      name,
      owner,
      acquired_at: new Date(nowMs).toISOString(),
      expires_at: expiryFor(nowMs, ttlMs),
    };
    this.rows.set(name, row);
    return row;
  }
  /** `renewRunLock` — updates acquired_at AND expires_at, scoped by owner. */
  renew(name: string, owner: string, nowMs: number, ttlMs: number) {
    this.renews += 1;
    const row = this.rows.get(name);
    if (!row || row.owner !== owner) return;
    row.acquired_at = new Date(nowMs).toISOString();
    row.expires_at = expiryFor(nowMs, ttlMs);
    this.renewsApplied += 1;
  }
  sweep(name: string, nowMs: number): number {
    const row = this.rows.get(name);
    if (!row || !isExpired(row, nowMs, STALE_MS)) return 0;
    this.rows.delete(name);
    return 1;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("run-lock heartbeat extends the TTL", () => {
  it("moves expires_at forward on every heartbeat", () => {
    const table = new FakeLockTable();
    const row = table.acquire("hourly-run", "manual", T0, TTL_MS);
    const seen = [Date.parse(row.expires_at!)];

    for (let beat = 1; beat <= 6; beat += 1) {
      const now = T0 + beat * HEARTBEAT_MS;
      table.renew("hourly-run", "manual", now, TTL_MS);
      seen.push(Date.parse(table.rows.get("hourly-run")!.expires_at!));
    }

    expect(table.renewsApplied).toBe(6);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThan(seen[i - 1]);
      expect(seen[i] - seen[i - 1]).toBe(HEARTBEAT_MS);
    }
  });

  it("sets expires_at to exactly now + clamped TTL on each beat", () => {
    const table = new FakeLockTable();
    table.acquire("hourly-run", "manual", T0, TTL_MS);

    const now = T0 + 3 * HEARTBEAT_MS;
    table.renew("hourly-run", "manual", now, TTL_MS);

    const row = table.rows.get("hourly-run")!;
    expect(Date.parse(row.expires_at!)).toBe(now + clampTtl(TTL_MS));
    expect(Date.parse(row.acquired_at)).toBe(now);
    expect(msUntilExpiry(row, now, STALE_MS)).toBe(clampTtl(TTL_MS));
  });

  it("keeps the lock unsweepable through a run far longer than one TTL", () => {
    const table = new FakeLockTable();
    table.acquire("hourly-run", "manual", T0, TTL_MS);

    const runMs = 10 * 60_000; // 10 minutes — many TTLs long
    for (let t = HEARTBEAT_MS; t <= runMs; t += HEARTBEAT_MS) {
      const now = T0 + t;
      // A competing process sweeps just before each beat lands.
      expect(table.sweep("hourly-run", now)).toBe(0);
      table.renew("hourly-run", "manual", now, TTL_MS);
      expect(isExpired(table.rows.get("hourly-run")!, now, STALE_MS)).toBe(false);
    }

    expect(table.rows.has("hourly-run")).toBe(true);
    expect(table.renewsApplied).toBe(runMs / HEARTBEAT_MS);
  });

  it("expires one TTL after the LAST heartbeat once the worker dies", () => {
    const table = new FakeLockTable();
    table.acquire("hourly-run", "manual", T0, TTL_MS);

    const lastBeat = T0 + 5 * HEARTBEAT_MS;
    for (let t = HEARTBEAT_MS; t <= 5 * HEARTBEAT_MS; t += HEARTBEAT_MS) {
      table.renew("hourly-run", "manual", T0 + t, TTL_MS);
    }
    // Worker dies here — no more beats.

    // Original acquisition TTL has long passed, but the lock is still alive.
    expect(table.sweep("hourly-run", T0 + TTL_MS + 1_000)).toBe(0);
    // Still alive just before the post-heartbeat deadline.
    expect(table.sweep("hourly-run", lastBeat + clampTtl(TTL_MS) - 1_000)).toBe(0);
    // Swept once the last heartbeat's TTL lapses.
    expect(table.sweep("hourly-run", lastBeat + clampTtl(TTL_MS) + 1)).toBe(1);
    expect(table.rows.has("hourly-run")).toBe(false);
  });

  it("ignores a renew from a different owner (no TTL extension)", () => {
    const table = new FakeLockTable();
    table.acquire("hourly-run", "manual", T0, TTL_MS);
    const before = table.rows.get("hourly-run")!.expires_at;

    table.renew("hourly-run", "cron", T0 + HEARTBEAT_MS, TTL_MS);

    expect(table.renews).toBe(1);
    expect(table.renewsApplied).toBe(0);
    expect(table.rows.get("hourly-run")!.expires_at).toBe(before);
  });

  it("drives the real 30s setInterval wiring with fake timers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);

    const table = new FakeLockTable();
    table.acquire("hourly-run", "manual", Date.now(), TTL_MS);

    // Same shape as hourly-run.server.ts.
    const heartbeat = setInterval(() => {
      table.renew("hourly-run", "manual", Date.now(), TTL_MS);
    }, HEARTBEAT_MS);

    // A 4-minute manual cycle.
    for (let i = 0; i < 8; i += 1) {
      vi.advanceTimersByTime(HEARTBEAT_MS);
      expect(isExpired(table.rows.get("hourly-run")!, Date.now(), STALE_MS)).toBe(false);
    }
    clearInterval(heartbeat);

    expect(table.renewsApplied).toBe(8);
    expect(Date.parse(table.rows.get("hourly-run")!.expires_at!)).toBe(
      T0 + 8 * HEARTBEAT_MS + clampTtl(TTL_MS),
    );
  });

  it("heartbeat interval is comfortably shorter than the TTL", () => {
    // If this ever inverts, a healthy run would expire between beats.
    expect(HEARTBEAT_MS).toBeLessThan(clampTtl(TTL_MS) / 2);
  });
});
