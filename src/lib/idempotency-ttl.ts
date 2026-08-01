// TTL policy for stored Idempotency-Key entries.
//
// Two clocks, because the two states mean different things:
//   - completed: keep the recorded response replayable for `COMPLETED_TTL_MS`
//     (24h — the same window Stripe advertises), then it may be dropped.
//   - in_progress: a reservation whose operation never finished (crash, cold
//     start) is a lock nobody will release, so it expires far sooner.
//
// After a completed row's replay window lapses it does NOT vanish immediately:
// it lingers as a tombstone for `EXPIRED_GRACE_MS`, so a late retry with the
// same key gets a clear "this key expired" answer instead of silently
// re-running the operation. Only past the grace window is the row purged.
//
// Expiry is enforced in three independent places so no single one has to be
// reliable: the row's `expires_at` default, the hourly database purge job, and
// the opportunistic checks in the store (which classify rows locally even when
// the sweeper has not run yet).

export const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
export const IN_PROGRESS_TTL_MS = 60 * 60 * 1000;
/** How long an expired completed key stays answerable as "expired". */
export const EXPIRED_GRACE_MS = 24 * 60 * 60 * 1000;

export function expiryFor(status: "in_progress" | "completed", now: number = Date.now()): string {
  const ttl = status === "completed" ? COMPLETED_TTL_MS : IN_PROGRESS_TTL_MS;
  return new Date(now + ttl).toISOString();
}

function ms(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export type IdempotencyRowState =
  /** Still within its TTL: replay or in-progress semantics apply. */
  | "live"
  /** Past its TTL but inside the grace window: answer "expired", do not re-run. */
  | "expired"
  /** Stale reservation nobody will release: reclaim the key and run again. */
  | "reclaimable"
  /** Past the grace window: safe to delete and treat the key as fresh. */
  | "purgeable";

export type IdempotencyRowLike = {
  status?: unknown;
  expires_at?: unknown;
  created_at?: unknown;
} | null | undefined;

export function classifyRow(row: IdempotencyRowLike, now: number = Date.now()): IdempotencyRowState {
  if (!row) return "purgeable";
  const expiresAt = ms(row.expires_at);
  const completed = row.status === "completed";

  if (!completed) {
    const createdAt = ms(row.created_at);
    const staleByCreation = createdAt !== null && now - createdAt >= IN_PROGRESS_TTL_MS;
    const staleByExpiry = expiresAt !== null && expiresAt <= now;
    // A dead lock is never a meaningful "expired response" — free it.
    return staleByCreation || staleByExpiry ? "reclaimable" : "live";
  }

  if (expiresAt === null || expiresAt > now) return "live";
  return now - expiresAt >= EXPIRED_GRACE_MS ? "purgeable" : "expired";
}

/**
 * True when a row must no longer be replayed (expired, stale or purgeable).
 * Retained for callers that only care about "is this still live?".
 */
export function isExpiredRow(row: IdempotencyRowLike, now: number = Date.now()): boolean {
  if (!row) return false;
  return classifyRow(row, now) !== "live";
}

/** When the key's replay window closed, for user-facing messaging. */
export function expiredAtIso(row: IdempotencyRowLike): string | null {
  if (!row) return null;
  const t = ms(row.expires_at);
  return t === null ? null : new Date(t).toISOString();
}
