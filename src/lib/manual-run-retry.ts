// Retry policy for request-bound MANUAL runs.
//
// A manual run is capped by a hard server-side deadline (55s). When a scoped
// selection is larger than one deadline's worth of ticks — or when the request
// itself times out / the lock was briefly held — some selected portfolios come
// back as `budget-exceeded` and never ticked. Clicking "Run" again by hand is
// the current workaround; this module encodes that retry automatically.
//
// Invariants:
//   - The per-attempt server deadline is NEVER extended. Retries are additional
//     bounded attempts, not a longer single run.
//   - A total retry window bounds the whole sequence, so a wedged backend can
//     never produce an unbounded retry loop.
//   - Retries only ever re-request portfolios that did NOT tick. Completed
//     portfolios are dropped from the next attempt, and the engine's
//     "already ticked" guard is a second line of defence against double-ticks.
//   - `force` is never set by a retry: force would bypass that guard.

import type { RunPortfolioStatus } from "@/lib/run-portfolio-status";

export type ManualRunRetryConfig = {
  /** Attempts after the first one. */
  maxRetries: number;
  /** First backoff delay in ms; doubles per attempt. */
  baseDelayMs: number;
  /** Upper bound for a single backoff delay. */
  maxDelayMs: number;
  /**
   * Hard wall-clock ceiling for the whole sequence, measured from the first
   * attempt's start. No retry is scheduled if it cannot start AND finish one
   * server deadline inside this window.
   */
  totalWindowMs: number;
  /** Server-side per-attempt deadline; used to check the window has room. */
  attemptBudgetMs: number;
};

export const DEFAULT_MANUAL_RUN_RETRY: ManualRunRetryConfig = {
  maxRetries: 3,
  baseDelayMs: 4_000,
  maxDelayMs: 20_000,
  totalWindowMs: 240_000,
  attemptBudgetMs: 55_000,
};

export type ManualRunAttemptOutcome =
  | { kind: "success"; portfolioStatus: RunPortfolioStatus[] }
  | { kind: "error"; code?: string; message: string };

export type ManualRunRetryDecision = {
  shouldRetry: boolean;
  /** Backoff before the next attempt (ms). */
  delayMs: number;
  /** Scope for the next attempt; empty array means "all eligible". */
  portfolioIds: string[];
  /** Human-readable reason, shown in the UI / toast. */
  reason: string;
  /** Machine-readable classification of this attempt's outcome. */
  outcome:
    | "complete"
    | "incomplete"
    | "timeout"
    | "lock_held"
    | "fatal"
    | "exhausted"
    | "window_closed";
};

/** Statuses that mean "this portfolio still needs a tick". */
const RETRYABLE_STATUSES = new Set(["skipped_budget", "skipped_other"]);

/** Transport/worker failures where the run may not have completed. */
export function isRetryableRunError(err: { code?: string; message?: string }): boolean {
  if (err.code === "run_in_progress") return true;
  const m = (err.message ?? "").toLowerCase();
  return (
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("failed to fetch") ||
    m.includes("network") ||
    m.includes("aborted") ||
    m.includes("exceeded the time limit") ||
    m.includes("worker") ||
    m.includes("502") ||
    m.includes("503") ||
    m.includes("504") ||
    m.includes("522") ||
    m.includes("524")
  );
}

/** Portfolios in scope that this attempt left un-ticked and could retry. */
export function pendingPortfolioIds(
  status: RunPortfolioStatus[],
  requestedIds: string[],
): string[] {
  const scoped = requestedIds.length > 0;
  return status
    .filter((r) => (scoped ? requestedIds.includes(r.id) : r.selected))
    .filter((r) => RETRYABLE_STATUSES.has(r.status))
    .map((r) => r.id);
}

export function backoffDelayMs(attempt: number, cfg: ManualRunRetryConfig): number {
  // attempt is 1-based: the delay AFTER attempt 1 is baseDelayMs.
  const raw = cfg.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(cfg.maxDelayMs, raw);
}

/**
 * Decides whether a further manual-run attempt should be made.
 *
 * @param attempt         1-based index of the attempt that just finished.
 * @param elapsedMs       ms since the FIRST attempt started.
 * @param requestedIds    the original selection ([] = all eligible).
 */
export function planManualRunRetry(input: {
  attempt: number;
  elapsedMs: number;
  requestedIds: string[];
  outcome: ManualRunAttemptOutcome;
  config?: Partial<ManualRunRetryConfig>;
}): ManualRunRetryDecision {
  const cfg = { ...DEFAULT_MANUAL_RUN_RETRY, ...(input.config ?? {}) };
  const no = (
    outcome: ManualRunRetryDecision["outcome"],
    reason: string,
  ): ManualRunRetryDecision => ({
    shouldRetry: false,
    delayMs: 0,
    portfolioIds: [],
    reason,
    outcome,
  });

  let nextIds: string[];
  let why: string;
  let outcome: ManualRunRetryDecision["outcome"];

  if (input.outcome.kind === "error") {
    if (!isRetryableRunError(input.outcome)) {
      return no("fatal", input.outcome.message);
    }
    // The attempt may have ticked some portfolios before dying, but we can't
    // know which — re-request the original scope and let the engine's
    // "already ticked" guard skip anything that completed.
    nextIds = [...input.requestedIds];
    outcome = input.outcome.code === "run_in_progress" ? "lock_held" : "timeout";
    why =
      outcome === "lock_held"
        ? "a run was already in progress"
        : `the attempt did not complete (${input.outcome.message})`;
  } else {
    const pending = pendingPortfolioIds(input.outcome.portfolioStatus, input.requestedIds);
    if (pending.length === 0) {
      return no("complete", "every selected portfolio was reached");
    }
    nextIds = pending;
    outcome = "incomplete";
    why = `${pending.length} selected portfolio${pending.length > 1 ? "s" : ""} hit the run deadline`;
  }

  if (input.attempt > cfg.maxRetries) {
    return no("exhausted", `${why} — retry limit (${cfg.maxRetries}) reached`);
  }

  const delayMs = backoffDelayMs(input.attempt, cfg);
  // Hard deadline: the next attempt must be able to start AND use a full
  // server budget inside the total window. Never stretch the per-run deadline.
  if (input.elapsedMs + delayMs + cfg.attemptBudgetMs > cfg.totalWindowMs) {
    return no(
      "window_closed",
      `${why} — retry window (${Math.round(cfg.totalWindowMs / 1000)}s) has no room for another attempt`,
    );
  }

  return {
    shouldRetry: true,
    delayMs,
    portfolioIds: nextIds,
    reason: `Retrying in ${Math.round(delayMs / 1000)}s — ${why}.`,
    outcome,
  };
}
