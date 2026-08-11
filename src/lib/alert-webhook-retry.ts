// Pure retry policy + delivery bookkeeping for outbound alert webhooks.
//
// Kept free of fetch/db so the classification rules (what is worth retrying,
// how long to wait, what the final status is) can be unit-tested directly.

export type WebhookAttemptOutcome = {
  attempt: number;
  ok: boolean;
  httpStatus?: number | null;
  error?: string | null;
  durationMs: number;
  at: string;
};

export type WebhookDeliveryStatus = "delivered" | "failed" | "skipped";

export const WEBHOOK_MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;

/**
 * Exponential backoff with deterministic jitter derived from the attempt
 * number, so tests stay stable while retries do not synchronise across
 * portfolios in the same hourly pass.
 */
export function backoffDelayMs(attempt: number, seed = 0): number {
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = ((seed + attempt * 7919) % 100) / 100; // 0..0.99
  return Math.round(base * (0.75 + 0.5 * jitter));
}

/**
 * 5xx, 408 and 429 are transient; other 4xx are a configuration problem and
 * retrying only produces noise. A thrown error (timeout, DNS, TLS) is
 * transient.
 */
export function isRetryableStatus(httpStatus: number | null | undefined): boolean {
  if (httpStatus == null) return true;
  if (httpStatus === 408 || httpStatus === 429) return true;
  return httpStatus >= 500 && httpStatus <= 599;
}

export function shouldRetry(
  outcome: Pick<WebhookAttemptOutcome, "ok" | "httpStatus">,
  attempt: number,
  maxAttempts = WEBHOOK_MAX_ATTEMPTS,
): boolean {
  if (outcome.ok) return false;
  if (attempt >= maxAttempts) return false;
  return isRetryableStatus(outcome.httpStatus ?? null);
}

export function summariseDelivery(attempts: WebhookAttemptOutcome[]): {
  status: WebhookDeliveryStatus;
  attempts: number;
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
} {
  if (attempts.length === 0) {
    return { status: "skipped", attempts: 0, httpStatus: null, error: null, durationMs: 0 };
  }
  const last = attempts[attempts.length - 1]!;
  const durationMs = attempts.reduce((sum, a) => sum + a.durationMs, 0);
  return {
    status: last.ok ? "delivered" : "failed",
    attempts: attempts.length,
    httpStatus: last.httpStatus ?? null,
    error: last.ok ? null : (last.error ?? `HTTP ${last.httpStatus ?? "error"}`),
    durationMs,
  };
}

/** Host only — never log the full URL, it can carry a signing token. */
export function endpointHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function describeDeliveryStatus(status: string, attempts: number): string {
  if (status === "delivered") {
    return attempts > 1 ? `Delivered after ${attempts} attempts` : "Delivered";
  }
  if (status === "failed") return `Failed after ${attempts} attempt${attempts === 1 ? "" : "s"}`;
  return "Not sent (no webhook configured)";
}
