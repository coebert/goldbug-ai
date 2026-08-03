// Cross-process concurrency lock backed by public.run_locks (service_role only).
// Used to prevent scheduled cron runs and manual admin triggers from
// overlapping.
//
// Three independent safety nets stop a crashed/timed-out run from wedging
// future runs:
//   1. TTL — every row carries an absolute `expires_at`; an expired row is
//      evictable by any process, even one that has never seen it before.
//      Healthy runs push it forward on each heartbeat.
//   2. Staleness age — legacy backstop on `acquired_at`.
//   3. Repeated-contention recovery — evicts a frozen heartbeat.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  clearContention,
  noteContention,
  shouldForceRecover,
} from "@/lib/run-lock-recovery";
import {
  DEFAULT_TTL_MS,
  clampTtl,
  expiryFor,
  isExpired,
  msUntilExpiry,
} from "@/lib/run-lock-ttl";

export type LockAcquired = {
  acquired: true;
  owner: string;
  /** Absolute TTL deadline (ISO) written for this lock. */
  expiresAt: string;
  release: () => Promise<void>;
  /** Refresh acquired_at + expires_at so a healthy long run isn't swept. */
  renew: () => Promise<void>;
};

export type LockBusy = {
  acquired: false;
  heldBy: string | null;
  acquiredAt: string; // ISO
  ageMs: number;
  /** Milliseconds until the holder's TTL lapses (negative once expired). */
  expiresInMs: number;
};

export type AcquireResult = LockAcquired | LockBusy;

/**
 * Delete every run_locks row whose TTL has lapsed. Safe to call from any
 * process at any time: a live holder heartbeats its expires_at forward, so it
 * is never in the deleted set. Returns the number of rows removed.
 */
export async function sweepExpiredRunLocks(
  opts: { name?: string; fallbackTtlMs?: number } = {},
): Promise<number> {
  const fallback = clampTtl(opts.fallbackTtlMs ?? DEFAULT_TTL_MS);
  const nowIso = new Date().toISOString();
  let removed = 0;
  try {
    // Rows written with a TTL: straight comparison on expires_at.
    let q = supabaseAdmin.from("run_locks").delete().lt("expires_at", nowIso);
    if (opts.name) q = q.eq("name", opts.name);
    const withTtl = await q.select("name, owner, expires_at");
    removed += withTtl.data?.length ?? 0;

    // Legacy rows with no TTL: fall back to acquired_at + fallback window.
    const legacyCutoff = new Date(Date.now() - fallback).toISOString();
    let q2 = supabaseAdmin
      .from("run_locks")
      .delete()
      .is("expires_at", null)
      .lt("acquired_at", legacyCutoff);
    if (opts.name) q2 = q2.eq("name", opts.name);
    const legacy = await q2.select("name, owner, acquired_at");
    removed += legacy.data?.length ?? 0;

    if (removed > 0) {
      console.warn(
        JSON.stringify({
          evt: "run_lock.ttl_sweep",
          level: "warn",
          removed,
          rows: [...(withTtl.data ?? []), ...(legacy.data ?? [])],
        }),
      );
    }
  } catch (e) {
    console.error("run-lock: TTL sweep failed", e);
  }
  return removed;
}

export async function acquireRunLock(
  name: string,
  opts: { owner?: string; staleMs?: number; ttlMs?: number } = {},
): Promise<AcquireResult> {
  const staleMs = opts.staleMs ?? 15 * 60 * 1000; // 15 min default
  const ttlMs = clampTtl(opts.ttlMs ?? DEFAULT_TTL_MS);
  const owner = opts.owner ?? `run-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date();

  // TTL sweep first: a lock left behind by a timed-out request is removed
  // here, so the insert below simply succeeds instead of reporting "busy".
  await sweepExpiredRunLocks({ name, fallbackTtlMs: staleMs });

  const claim = () => ({
    name,
    acquired_at: now.toISOString(),
    owner,
    expires_at: expiryFor(now.getTime(), ttlMs),
  });
  const acquired = (row: { expires_at: string }): LockAcquired => ({
    acquired: true,
    owner,
    expiresAt: row.expires_at,
    release: () => releaseRunLock(name, owner),
    renew: () => renewRunLock(name, owner, ttlMs),
  });

  // Attempt insert. If row already exists, on-conflict do nothing returns no row.
  const first = claim();
  const ins = await supabaseAdmin
    .from("run_locks")
    .insert(first)
    .select("owner, acquired_at")
    .maybeSingle();

  if (ins.data) {
    clearContention(name);
    return acquired(first);
  }

  // Existing row — check TTL, then staleness.
  const cur = await supabaseAdmin
    .from("run_locks")
    .select("owner, acquired_at, expires_at")
    .eq("name", name)
    .maybeSingle();

  if (!cur.data) {
    // Race: was deleted between insert-conflict and select. Retry once.
    const second = claim();
    const retry = await supabaseAdmin
      .from("run_locks")
      .insert(second)
      .select("owner, acquired_at")
      .maybeSingle();
    if (retry.data) {
      clearContention(name);
      return acquired(second);
    }
    return {
      acquired: false,
      heldBy: null,
      acquiredAt: now.toISOString(),
      ageMs: 0,
      expiresInMs: 0,
    };
  }

  const acquiredAt = cur.data.acquired_at as string;
  const ageMs = Date.now() - new Date(acquiredAt).getTime();
  const ttlRow = {
    acquired_at: acquiredAt,
    expires_at: (cur.data as { expires_at?: string | null }).expires_at ?? null,
  };
  const ttlExpired = isExpired(ttlRow, Date.now(), staleMs);

  // Record this contention. If the holder is alive it heartbeats `acquired_at`
  // forward, which resets the observation window and makes recovery impossible.
  const contention = noteContention({
    name,
    acquiredAt,
    heldBy: (cur.data.owner as string | null) ?? null,
    observedAt: Date.now(),
  });
  const recovery = shouldForceRecover(contention, { now: Date.now() });

  if (ttlExpired || ageMs > staleMs || recovery.recover) {
    // Evict and claim. Use delete-then-insert (rather than an in-place UPDATE)
    // so a crashed worker whose row somehow survived can never wedge future
    // runs. The delete is scoped by (name, acquired_at) so a concurrent
    // healthy holder that already renewed the row is not clobbered.
    const del = await supabaseAdmin
      .from("run_locks")
      .delete()
      .eq("name", name)
      .eq("acquired_at", acquiredAt)
      .select("name")
      .maybeSingle();
    if (del.data) {
      const third = claim();
      const claimed = await supabaseAdmin
        .from("run_locks")
        .insert(third)
        .select("owner, acquired_at")
        .maybeSingle();
      if (claimed.data) {
        const trigger = ttlExpired
          ? "ttl-expired"
          : recovery.recover
            ? `repeated-contention x${recovery.observations}`
            : "age";
        console.warn(
          `run-lock: evicted stale "${name}" (age ${Math.round(ageMs / 1000)}s, prev owner ${cur.data.owner ?? "unknown"}, trigger ${trigger})`,
        );
        clearContention(name);
        return acquired(third);
      }
    }
    // Someone else won the takeover race — fall through to busy.
  }

  return {
    acquired: false,
    heldBy: (cur.data.owner as string | null) ?? null,
    acquiredAt,
    ageMs,
    expiresInMs: msUntilExpiry(ttlRow, Date.now(), staleMs),
  };
}

/**
 * Heartbeat: push `acquired_at` and the TTL deadline forward for a lock we
 * still hold. This lets the TTL stay short (a dead isolate frees the lock
 * quickly) without a healthy long-running cycle getting evicted mid-flight.
 */
export async function renewRunLock(
  name: string,
  owner: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<void> {
  try {
    await supabaseAdmin
      .from("run_locks")
      .update({
        acquired_at: new Date().toISOString(),
        expires_at: expiryFor(Date.now(), ttlMs),
      })
      .eq("name", name)
      .eq("owner", owner);
  } catch (e) {
    console.warn(`run-lock: renew failed for "${name}"`, e);
  }
}

export async function releaseRunLock(name: string, owner: string): Promise<void> {
  clearContention(name);
  try {
    await supabaseAdmin.from("run_locks").delete().eq("name", name).eq("owner", owner);
  } catch (e) {
    console.error(`run-lock: release failed for "${name}"`, e);
  }
}
