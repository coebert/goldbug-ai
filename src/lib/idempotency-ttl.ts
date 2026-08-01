// TTL policy for stored Idempotency-Key entries.
//
// Two clocks, because the two states mean different things:
//   - completed: keep the recorded response replayable for `COMPLETED_TTL_MS`
//     (24h — the same window Stripe advertises), then it may be dropped.
//   - in_progress: a reservation whose operation never finished (crash, cold
//     start) is a lock nobody will release, so it expires far sooner.
//
// Expiry is enforced in three independent places so no single one has to be
// reliable: the row's `expires_at` default, the hourly database purge job, and
// the opportunistic checks in the store below (which treat an expired row as
// absent even if the sweeper has not run yet).

export const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
export const IN_PROGRESS_TTL_MS = 60 * 60 * 1000;

export function expiryFor(status: "in_progress" | "completed", now: number = Date.now()): string {
  const ttl = status === "completed" ? COMPLETED_TTL_MS : COMPLETED_TTL_MS;
  return new Date(now + ttl).toISOString();
}

function ms(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * True when a row must be treated as if it does not exist.
 *
 * Either its `expires_at` has passed, or it is a stale `in_progress`
 * reservation older than `IN_PROGRESS_TTL_MS`.
 */
export function isExpiredRow(
  row: { status?: unknown; expires_at?: unknown; created_at?: unknown } | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!row) return false;
  const expiresAt = ms(row.expires_at);
  if (expiresAt !== null && expiresAt <= now) return true;
  if (row.status !== "completed") {
    const createdAt = ms(row.created_at);
    if (createdAt !== null && now - createdAt >= IN_PROGRESS_TTL_MS) return true;
  }
  return false;
}
