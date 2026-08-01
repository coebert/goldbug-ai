// Deadline guard for slicer database work.
//
// The hourly slicer tick runs inside a cron request with a hard wall-clock
// budget. A single PostgREST call that never settles (dropped connection,
// stalled pool) used to hang the whole tick: no expiry sweep, no child orders,
// and no error to alert on — the run simply timed out.
//
// `withSlicerDeadline` bounds every awaited call. On expiry it either throws a
// tagged `SlicerTimeoutError` (so the caller can log and alert) or resolves to
// a caller-supplied fallback, which keeps a best-effort tick going when the
// query is not load-bearing.
//
// Pure except for timers — safe to import anywhere.

/** Default budget for one PostgREST round-trip inside the slicer. */
export const SLICER_DB_TIMEOUT_MS = 8_000;

/** Total budget for one slicer tick across all of its queries. */
export const SLICER_TICK_BUDGET_MS = 25_000;

export class SlicerTimeoutError extends Error {
  constructor(
    public readonly op: string,
    public readonly timeoutMs: number,
  ) {
    super(`pending_slices: ${op} exceeded ${timeoutMs}ms deadline`);
    this.name = "SlicerTimeoutError";
  }
}

export type DeadlineOptions<T> = {
  timeoutMs?: number;
  /** When provided, a timeout resolves to this value instead of throwing. */
  fallback?: T;
  onTimeout?: (op: string, timeoutMs: number) => void;
};

/**
 * Race `work` against a timer. Always clears the timer, so a resolved promise
 * never keeps the runtime alive.
 */
export async function withSlicerDeadline<T>(
  op: string,
  work: Promise<T> | (() => Promise<T>),
  options: DeadlineOptions<T> = {},
): Promise<T> {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0
      ? (options.timeoutMs as number)
      : SLICER_DB_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = typeof work === "function" ? work() : work;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SlicerTimeoutError(op, timeoutMs)), timeoutMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof SlicerTimeoutError) {
      options.onTimeout?.(op, timeoutMs);
      if ("fallback" in options) return options.fallback as T;
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Tracks the remaining budget for a whole tick so a sequence of slow-but-not-
 * timed-out queries cannot silently blow the cron window.
 */
export function createTickBudget(totalMs: number = SLICER_TICK_BUDGET_MS, now: () => number = Date.now) {
  const started = now();
  const budget = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : SLICER_TICK_BUDGET_MS;
  return {
    /** Milliseconds left; never negative. */
    remaining(): number {
      return Math.max(0, budget - (now() - started));
    },
    expired(): boolean {
      return now() - started >= budget;
    },
    /** Per-call timeout that never exceeds what's left of the tick. */
    slice(preferredMs: number = SLICER_DB_TIMEOUT_MS): number {
      const left = Math.max(0, budget - (now() - started));
      return Math.max(1, Math.min(preferredMs, left));
    },
  };
}
