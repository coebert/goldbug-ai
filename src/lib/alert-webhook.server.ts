// Outbound alert webhook delivery with retries, and a persisted delivery log.
//
// Every attempt is recorded so a half-working integration (endpoint 500s,
// wrong token, DNS gone) is visible in the UI instead of dying in a
// console.warn nobody reads.

import {
  WEBHOOK_MAX_ATTEMPTS,
  backoffDelayMs,
  endpointHost,
  shouldRetry,
  summariseDelivery,
  type WebhookAttemptOutcome,
} from "./alert-webhook-retry";

const TIMEOUT_MS = 5_000;

async function postOnce(
  url: string,
  headers: Record<string, string>,
  body: string,
  attempt: number,
): Promise<WebhookAttemptOutcome> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
    await res.body?.cancel().catch(() => undefined);
    return {
      attempt,
      ok: res.ok,
      httpStatus: res.status,
      error: res.ok ? null : `HTTP ${res.status}`,
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    };
  } catch (e) {
    return {
      attempt,
      ok: false,
      httpStatus: null,
      error: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST a payload with bounded retries and log the outcome to
 * `alert_webhook_deliveries`. Never throws — alerting must not break the
 * hourly run.
 */
export async function deliverAlertWebhook(params: {
  url?: string | null;
  token?: string | null;
  category: string;
  event: string;
  userId: string;
  portfolioId?: string | null;
  payload: Record<string, unknown>;
  maxAttempts?: number;
}): Promise<{ status: string; attempts: number }> {
  const { url, token, category, event, userId, portfolioId, payload } = params;
  const maxAttempts = params.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS;
  const attempts: WebhookAttemptOutcome[] = [];

  if (url) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["authorization"] = `Bearer ${token}`;
    const body = JSON.stringify({ event, ...payload });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const outcome = await postOnce(url, headers, body, attempt);
      attempts.push(outcome);
      if (!shouldRetry(outcome, attempt, maxAttempts)) break;
      await new Promise((r) => setTimeout(r, backoffDelayMs(attempt, attempt)));
    }
  }

  const summary = summariseDelivery(attempts);

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("alert_webhook_deliveries").insert({
      user_id: userId,
      portfolio_id: portfolioId ?? null,
      category,
      event,
      endpoint_host: url ? endpointHost(url) : null,
      status: summary.status,
      attempts: summary.attempts,
      http_status: summary.httpStatus,
      error: summary.error,
      duration_ms: summary.durationMs,
      attempt_log: attempts as unknown as never,
      payload: payload as unknown as never,
    });
  } catch (e) {
    console.warn("alert webhook log failed", e instanceof Error ? e.message : String(e));
  }

  if (summary.status === "failed") {
    console.warn(`alert webhook ${category} failed`, summary.attempts, summary.error);
  }
  return { status: summary.status, attempts: summary.attempts };
}
