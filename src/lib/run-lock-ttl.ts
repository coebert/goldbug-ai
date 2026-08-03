// TTL policy for run_locks — pure logic, no database access.
//
// Background: a manual run executes inside a single worker request. If that
// request is terminated (deadline, isolate eviction, deploy) the `finally`
// block that releases the lock never runs, and the row survives. Heartbeat
// based recovery (`run-lock-recovery`) only fires after several *contended*
// acquire attempts observed by the same isolate, which is not guaranteed.
//
// A TTL closes that hole deterministically: every lock row carries an
// absolute `expires_at`. Once that instant passes the row is garbage to
// everyone — any process, any isolate, and the database sweep job — so a
// timed-out run can never wedge the next one for longer than the TTL.

/** Grace added on top of a run's own time budget before the lock expires. */
export const TTL_GRACE_MS = 20_000;

/** Floor so a tiny budget still gives the run room to finish. */
export const MIN_TTL_MS = 60_000;

/** Ceiling so a bad budget value cannot create a near-permanent lock. */
export const MAX_TTL_MS = 10 * 60_000;

/** TTL used when a caller does not supply one. */
export const DEFAULT_TTL_MS = 90_000;

/**
 * Convert a run's time budget into a lock TTL: budget + grace, clamped.
 * The grace covers post-loop work (metrics persistence, release) so a healthy
 * run's lock never expires underneath it while it is still finishing.
 */
export function lockTtlMsForBudget(budgetMs: number | undefined | null): number {
  const budget = Number.isFinite(budgetMs) ? Number(budgetMs) : NaN;
  if (!Number.isFinite(budget) || budget <= 0) return DEFAULT_TTL_MS;
  return clampTtl(budget + TTL_GRACE_MS);
}

export function clampTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.round(ttlMs)));
}

/** Absolute ISO expiry for a lock acquired (or renewed) at `now`. */
export function expiryFor(nowMs: number, ttlMs: number): string {
  return new Date(nowMs + clampTtl(ttlMs)).toISOString();
}

export type LockRowTtl = {
  acquired_at: string;
  expires_at?: string | null;
};

/**
 * Effective deadline for a row. Rows written before the TTL column existed
 * (or by an older deploy) fall back to acquired_at + fallbackTtlMs so legacy
 * rows are still cleaned up rather than living forever.
 */
export function effectiveExpiryMs(row: LockRowTtl, fallbackTtlMs = DEFAULT_TTL_MS): number {
  const explicit = row.expires_at ? Date.parse(row.expires_at) : NaN;
  if (Number.isFinite(explicit)) return explicit;
  const acquired = Date.parse(row.acquired_at);
  if (!Number.isFinite(acquired)) return 0; // unparseable → treat as expired
  return acquired + clampTtl(fallbackTtlMs);
}

/** True when the row's TTL has elapsed and it may be evicted by anyone. */
export function isExpired(
  row: LockRowTtl,
  nowMs: number,
  fallbackTtlMs = DEFAULT_TTL_MS,
): boolean {
  return effectiveExpiryMs(row, fallbackTtlMs) <= nowMs;
}

/** Milliseconds until expiry; negative once the TTL has elapsed. */
export function msUntilExpiry(
  row: LockRowTtl,
  nowMs: number,
  fallbackTtlMs = DEFAULT_TTL_MS,
): number {
  return effectiveExpiryMs(row, fallbackTtlMs) - nowMs;
}
