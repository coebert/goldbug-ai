// Cross-process concurrency lock backed by public.run_locks (service_role only).
// Used to prevent scheduled cron runs and manual admin triggers from
// overlapping. Stale locks (older than staleMs) are auto-evicted so a crashed
// run cannot permanently block future runs.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type LockAcquired = {
  acquired: true;
  owner: string;
  release: () => Promise<void>;
};

export type LockBusy = {
  acquired: false;
  heldBy: string | null;
  acquiredAt: string; // ISO
  ageMs: number;
};

export type AcquireResult = LockAcquired | LockBusy;

export async function acquireRunLock(
  name: string,
  opts: { owner?: string; staleMs?: number } = {},
): Promise<AcquireResult> {
  const staleMs = opts.staleMs ?? 15 * 60 * 1000; // 15 min default
  const owner = opts.owner ?? `run-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date();

  // Attempt insert. If row already exists, on-conflict do nothing returns no row.
  const ins = await supabaseAdmin
    .from("run_locks")
    .insert({ name, acquired_at: now.toISOString(), owner })
    .select("owner, acquired_at")
    .maybeSingle();

  if (ins.data) {
    return {
      acquired: true,
      owner,
      release: () => releaseRunLock(name, owner),
    };
  }

  // Existing row — check staleness.
  const cur = await supabaseAdmin
    .from("run_locks")
    .select("owner, acquired_at")
    .eq("name", name)
    .maybeSingle();

  if (!cur.data) {
    // Race: was deleted between insert-conflict and select. Retry once.
    const retry = await supabaseAdmin
      .from("run_locks")
      .insert({ name, acquired_at: now.toISOString(), owner })
      .select("owner, acquired_at")
      .maybeSingle();
    if (retry.data) {
      return { acquired: true, owner, release: () => releaseRunLock(name, owner) };
    }
    return { acquired: false, heldBy: null, acquiredAt: now.toISOString(), ageMs: 0 };
  }

  const acquiredAt = cur.data.acquired_at as string;
  const ageMs = Date.now() - new Date(acquiredAt).getTime();

  if (ageMs > staleMs) {
    // Evict stale lock and claim it.
    const takeover = await supabaseAdmin
      .from("run_locks")
      .update({ owner, acquired_at: now.toISOString() })
      .eq("name", name)
      .eq("acquired_at", acquiredAt)
      .select("owner")
      .maybeSingle();
    if (takeover.data) {
      console.warn(`run-lock: evicted stale "${name}" (age ${Math.round(ageMs / 1000)}s)`);
      return { acquired: true, owner, release: () => releaseRunLock(name, owner) };
    }
    // Someone else won the takeover race — fall through to busy.
  }

  return {
    acquired: false,
    heldBy: (cur.data.owner as string | null) ?? null,
    acquiredAt,
    ageMs,
  };
}

export async function releaseRunLock(name: string, owner: string): Promise<void> {
  try {
    await supabaseAdmin.from("run_locks").delete().eq("name", name).eq("owner", owner);
  } catch (e) {
    console.error(`run-lock: release failed for "${name}"`, e);
  }
}
