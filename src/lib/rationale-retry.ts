// Retry policy for failed rationale recalculations.
//
// Pure so the classification (what is worth retrying, how long to wait, what
// the user is told) can be unit-tested without react-query or the network.

export const RATIONALE_MAX_AUTO_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 15_000;

/** Exponential backoff with deterministic jitter (attempt is 1-based). */
export function rationaleRetryDelayMs(attempt: number, seed = 0): number {
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = ((seed + attempt * 7919) % 100) / 100; // 0..0.99
  return Math.round(base * (0.75 + 0.5 * jitter));
}

/**
 * Auth/permission/validation failures will fail identically on a retry, so
 * only transient conditions are auto-retried. Anything else stays on screen
 * with a manual "Retry now" affordance.
 */
export function isRetryableRationaleError(error: unknown): boolean {
  const msg = errorMessage(error).toLowerCase();
  if (/\b(401|403|404|422|400)\b|unauthorized|forbidden|not found|invalid/.test(msg)) return false;
  return true;
}

export function shouldAutoRetryRationale(
  error: unknown,
  attempt: number,
  maxRetries = RATIONALE_MAX_AUTO_RETRIES,
): boolean {
  if (attempt >= maxRetries) return false;
  return isRetryableRationaleError(error);
}

export function errorMessage(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  const m = (error as { message?: unknown }).message;
  return typeof m === "string" ? m : String(error);
}

/** One-line status shown inline when a recalculation failed. */
export function describeRationaleFailure(
  error: unknown,
  attempt: number,
  maxRetries = RATIONALE_MAX_AUTO_RETRIES,
): string {
  const detail = errorMessage(error) || "unknown error";
  if (!isRetryableRationaleError(error)) {
    return `Couldn't recalculate levels — ${detail}. This won't resolve on its own.`;
  }
  if (attempt >= maxRetries) {
    return `Couldn't recalculate levels after ${attempt} attempt${attempt === 1 ? "" : "s"} — ${detail}.`;
  }
  return `Recalculation failed (${detail}) — retrying automatically…`;
}
