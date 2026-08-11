import { describe, it, expect } from "vitest";
import {
  backoffDelayMs,
  isRetryableStatus,
  shouldRetry,
  summariseDelivery,
  endpointHost,
  describeDeliveryStatus,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookAttemptOutcome,
} from "../alert-webhook-retry";

const attempt = (o: Partial<WebhookAttemptOutcome> & { attempt: number; ok: boolean }): WebhookAttemptOutcome => ({
  httpStatus: null,
  error: null,
  durationMs: 10,
  at: "2026-08-11T15:00:00.000Z",
  ...o,
});

describe("alert webhook retry policy", () => {
  it("treats 5xx, 408, 429 and network errors as retryable", () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(null)).toBe(true);
  });

  it("does not retry configuration errors", () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });

  it("stops retrying on success or at the attempt ceiling", () => {
    expect(shouldRetry({ ok: true, httpStatus: 200 }, 1)).toBe(false);
    expect(shouldRetry({ ok: false, httpStatus: 500 }, 1)).toBe(true);
    expect(shouldRetry({ ok: false, httpStatus: 500 }, WEBHOOK_MAX_ATTEMPTS)).toBe(false);
    expect(shouldRetry({ ok: false, httpStatus: 401 }, 1)).toBe(false);
  });

  it("backs off exponentially within bounds", () => {
    const d1 = backoffDelayMs(1);
    const d2 = backoffDelayMs(2);
    const d9 = backoffDelayMs(9);
    expect(d1).toBeGreaterThan(0);
    expect(d2).toBeGreaterThan(d1 * 1.2);
    expect(d9).toBeLessThanOrEqual(8_000 * 1.25);
  });
});

describe("delivery summary", () => {
  it("marks skipped when nothing was attempted", () => {
    expect(summariseDelivery([])).toMatchObject({ status: "skipped", attempts: 0 });
  });

  it("marks delivered when the last attempt succeeded after retries", () => {
    const s = summariseDelivery([
      attempt({ attempt: 1, ok: false, httpStatus: 500, error: "HTTP 500", durationMs: 40 }),
      attempt({ attempt: 2, ok: true, httpStatus: 200, durationMs: 20 }),
    ]);
    expect(s.status).toBe("delivered");
    expect(s.attempts).toBe(2);
    expect(s.error).toBeNull();
    expect(s.durationMs).toBe(60);
  });

  it("marks failed and keeps the last error", () => {
    const s = summariseDelivery([
      attempt({ attempt: 1, ok: false, httpStatus: null, error: "aborted" }),
      attempt({ attempt: 2, ok: false, httpStatus: 502, error: "HTTP 502" }),
    ]);
    expect(s).toMatchObject({ status: "failed", attempts: 2, httpStatus: 502, error: "HTTP 502" });
  });
});

describe("presentation helpers", () => {
  it("logs only the host, never the full signed URL", () => {
    expect(endpointHost("https://hooks.example.com/x?token=abc")).toBe("hooks.example.com");
    expect(endpointHost("not a url")).toBeNull();
  });

  it("describes status readably", () => {
    expect(describeDeliveryStatus("delivered", 1)).toBe("Delivered");
    expect(describeDeliveryStatus("delivered", 3)).toBe("Delivered after 3 attempts");
    expect(describeDeliveryStatus("failed", 1)).toBe("Failed after 1 attempt");
    expect(describeDeliveryStatus("skipped", 0)).toMatch(/Not sent/);
  });
});
