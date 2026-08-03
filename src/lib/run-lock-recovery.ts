// Automatic recovery for wedged run_locks rows.
//
// A healthy run heartbeats its lock (see `renewRunLock`), pushing
// `acquired_at` forward every HEARTBEAT_INTERVAL_MS. A run whose worker
// isolate died can never do that, so its `acquired_at` is frozen.
//
// This module turns that difference into a safe eviction rule: we only force
// recovery after we have observed the SAME frozen `acquired_at` across
// several contended acquire attempts spanning more than two heartbeat
// intervals. Any heartbeat from a live holder resets the observation window,
// so an active run can never be evicted by this path.
//
// Pure logic — no database access — so it is directly unit-testable.

export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Minimum number of contended observations before recovery is allowed. */
export const MIN_CONTENTION_OBSERVATIONS = 3;

/**
 * The frozen `acquired_at` must persist for at least this long. Two heartbeat
 * intervals plus grace: a live holder would have renewed at least twice.
 */
export const RECOVERY_WINDOW_MS = HEARTBEAT_INTERVAL_MS * 2 + 15_000; // 75s

export type ContentionState = {
  /** Lock name. */
  name: string;
  /** The `acquired_at` value we have been repeatedly observing. */
  acquiredAt: string;
  /** Owner reported alongside that acquired_at (informational). */
  heldBy: string | null;
  /** Wall clock (ms) of the first observation of this acquired_at. */
  firstObservedAt: number;
  /** Wall clock (ms) of the most recent observation. */
  lastObservedAt: number;
  /** How many contended attempts have seen this exact acquired_at. */
  observations: number;
};

export type ContentionInput = {
  name: string;
  acquiredAt: string;
  heldBy?: string | null;
  observedAt: number;
};

/**
 * Fold a contended observation into the running state. If the holder
 * heartbeated (acquired_at moved) or a different lock generation appeared,
 * the window restarts from scratch.
 */
export function recordContention(
  prev: ContentionState | null | undefined,
  input: ContentionInput,
): ContentionState {
  const heldBy = input.heldBy ?? null;
  if (
    !prev ||
    prev.name !== input.name ||
    prev.acquiredAt !== input.acquiredAt ||
    input.observedAt < prev.lastObservedAt
  ) {
    return {
      name: input.name,
      acquiredAt: input.acquiredAt,
      heldBy,
      firstObservedAt: input.observedAt,
      lastObservedAt: input.observedAt,
      observations: 1,
    };
  }
  return {
    ...prev,
    heldBy,
    lastObservedAt: input.observedAt,
    observations: prev.observations + 1,
  };
}

export type RecoveryDecision = {
  recover: boolean;
  reason:
    | "no-state"
    | "too-few-observations"
    | "window-too-short"
    | "holder-heartbeating"
    | "stale-lock-confirmed";
  observations: number;
  observedForMs: number;
  lockAgeMs: number;
};

/**
 * Decide whether a contended lock may be force-recovered.
 *
 * Safety invariants:
 * - never recover on a single observation (a slow-but-alive run must not lose its lock)
 * - never recover unless the same `acquired_at` persisted past two heartbeats
 * - never recover if the lock row is younger than the recovery window
 */
export function shouldForceRecover(
  state: ContentionState | null | undefined,
  opts: {
    now: number;
    minObservations?: number;
    recoveryWindowMs?: number;
  },
): RecoveryDecision {
  const minObservations = opts.minObservations ?? MIN_CONTENTION_OBSERVATIONS;
  const recoveryWindowMs = opts.recoveryWindowMs ?? RECOVERY_WINDOW_MS;

  if (!state) {
    return {
      recover: false,
      reason: "no-state",
      observations: 0,
      observedForMs: 0,
      lockAgeMs: 0,
    };
  }

  const observedForMs = Math.max(0, state.lastObservedAt - state.firstObservedAt);
  const acquiredMs = new Date(state.acquiredAt).getTime();
  const lockAgeMs = Number.isFinite(acquiredMs) ? Math.max(0, opts.now - acquiredMs) : 0;

  if (state.observations < minObservations) {
    return { recover: false, reason: "too-few-observations", observations: state.observations, observedForMs, lockAgeMs };
  }
  if (observedForMs < recoveryWindowMs) {
    return { recover: false, reason: "window-too-short", observations: state.observations, observedForMs, lockAgeMs };
  }
  if (lockAgeMs < recoveryWindowMs) {
    // The row is newer than our observation window — the holder must have
    // renewed (or the row was re-claimed). Treat as alive.
    return { recover: false, reason: "holder-heartbeating", observations: state.observations, observedForMs, lockAgeMs };
  }

  return { recover: true, reason: "stale-lock-confirmed", observations: state.observations, observedForMs, lockAgeMs };
}

// ---------------------------------------------------------------------------
// Per-isolate registry. Cron ticks that share a warm isolate accumulate
// observations here; a cold isolate simply starts over (fail-safe: it will not
// evict anything until it has re-observed the freeze itself).
// ---------------------------------------------------------------------------

const registry = new Map<string, ContentionState>();

export function noteContention(input: ContentionInput): ContentionState {
  const next = recordContention(registry.get(input.name), input);
  registry.set(input.name, next);
  return next;
}

export function getContention(name: string): ContentionState | null {
  return registry.get(name) ?? null;
}

export function clearContention(name: string): void {
  registry.delete(name);
}

/** Test helper. */
export function resetContentionRegistry(): void {
  registry.clear();
}
