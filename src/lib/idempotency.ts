// Idempotency-Key support (pure, storage-agnostic).
//
// Contract implemented here — deliberately the same one Stripe/GitHub use:
//   - First call with a key runs the operation and stores its response.
//   - Any later call with the SAME key and the SAME request returns the stored
//     response byte-for-byte, with `replayed: true`. The operation does not run
//     again.
//   - Same key with a DIFFERENT request is a client bug, not a retry: it is
//     rejected rather than silently replaying the wrong payload.
//   - Two concurrent calls with the same key: exactly one runs; the loser is
//     told to retry rather than duplicating the side effect.
//
// The store is injected so this file stays trivially testable and can sit in
// front of any endpoint, not just deactivate.

/** Stable fingerprint of a request payload; key order must not matter. */
export function requestFingerprint(payload: unknown): string {
  return hashString(canonicalJson(payload));
}

/** JSON with object keys sorted recursively, so {a,b} and {b,a} match. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Small deterministic non-crypto hash (FNV-1a, 64-bit-ish via two lanes). */
export function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + 0x9e3779b9), 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export const IDEMPOTENCY_KEY_MAX = 255;

export class IdempotencyKeyReuseError extends Error {
  constructor(key: string) {
    super(
      `Idempotency-Key "${key}" was already used with a different request payload. ` +
        `Use a new key for a new request.`,
    );
    this.name = "IdempotencyKeyReuseError";
  }
}

export class IdempotencyInProgressError extends Error {
  constructor(key: string) {
    super(
      `A request with Idempotency-Key "${key}" is still in progress. ` +
        `Retry shortly to receive the original response.`,
    );
    this.name = "IdempotencyInProgressError";
  }
}

/**
 * The key was used successfully, but its replay window has closed, so the
 * original response is gone. We refuse to run the operation again under an
 * expired key: the client must decide whether the first attempt counted.
 */
export class IdempotencyKeyExpiredError extends Error {
  readonly key: string;
  readonly expiredAt: string | null;
  constructor(key: string, expiredAt: string | null) {
    super(
      `Idempotency-Key "${key}" has expired${expiredAt ? ` (replay window closed ${expiredAt})` : ""}. ` +
        `The original response is no longer stored and the request was NOT re-run. ` +
        `Check the current state, then retry with a new Idempotency-Key if the operation is still needed.`,
    );
    this.name = "IdempotencyKeyExpiredError";
    this.key = key;
    this.expiredAt = expiredAt ?? null;
  }
}

export class InvalidIdempotencyKeyError extends Error {
  constructor() {
    super(`Idempotency-Key must be a non-empty string of at most ${IDEMPOTENCY_KEY_MAX} characters.`);
    this.name = "InvalidIdempotencyKeyError";
  }
}

export type IdempotencyRecord = {
  status: "in_progress" | "completed" | "expired";
  request_hash: string;
  response: unknown;
  /** Set when `status === "expired"`: when the replay window closed. */
  expired_at?: string | null;
};


export type IdempotencyStore = {
  /**
   * Attempt to reserve the key. Returns `{ reserved: true }` when this caller
   * won and must run the operation, or the existing record when it did not.
   * Implementations MUST make this atomic (unique index / insert-on-conflict).
   */
  reserve: (args: {
    userId: string;
    endpoint: string;
    key: string;
    requestHash: string;
  }) => Promise<{ reserved: true } | { reserved: false; existing: IdempotencyRecord }>;
  /** Persist the response for a reserved key. */
  complete: (args: {
    userId: string;
    endpoint: string;
    key: string;
    response: unknown;
  }) => Promise<void>;
  /** Drop the reservation so a failed call can be retried with the same key. */
  release: (args: { userId: string; endpoint: string; key: string }) => Promise<void>;
};

export function normalizeIdempotencyKey(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new InvalidIdempotencyKeyError();
  const key = raw.trim();
  if (!key) return null;
  if (key.length > IDEMPOTENCY_KEY_MAX) throw new InvalidIdempotencyKeyError();
  return key;
}

export type IdempotentOutcome<T> = { replayed: boolean; response: T };

/**
 * Run `operation` at most once per (user, endpoint, key).
 *
 * With no key supplied the operation simply runs — callers that don't opt in
 * keep the previous behaviour exactly.
 */
export async function withIdempotency<T>(
  store: IdempotencyStore | null,
  args: {
    userId: string;
    endpoint: string;
    key: string | null;
    request: unknown;
  },
  operation: () => Promise<T>,
): Promise<IdempotentOutcome<T>> {
  if (!store || !args.key) return { replayed: false, response: await operation() };

  const requestHash = requestFingerprint(args.request);
  const scope = { userId: args.userId, endpoint: args.endpoint, key: args.key };

  const reservation = await store.reserve({ ...scope, requestHash });
  if (!reservation.reserved) {
    const existing = reservation.existing;
    // Different payload under the same key: never replay someone else's answer.
    if (existing.request_hash !== requestHash) throw new IdempotencyKeyReuseError(args.key);
    if (existing.status !== "completed") throw new IdempotencyInProgressError(args.key);
    return { replayed: true, response: existing.response as T };
  }

  let response: T;
  try {
    response = await operation();
  } catch (err) {
    // Failure is not a recorded outcome — free the key so the same retry works.
    await store.release(scope).catch(() => undefined);
    throw err;
  }

  await store.complete({ ...scope, response });
  return { replayed: false, response };
}
