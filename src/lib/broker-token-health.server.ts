// Phase 6 — broker credential hygiene.
//
// Every scheduled Saxo token rotation reports its outcome here. Successes are
// recorded (so "when did this last work?" is answerable); failures are audited
// to `security_audit_log` under the `broker_token` event and escalated to the
// administrators through the shared alert fan-out, with the same threshold +
// cool-down machinery used for rejected access and webhook probing.
//
// A stale or leaked broker token has a short life only if a failed rotation is
// noticed: without this, a refresh that starts failing is silent until the
// refresh window lapses and live trading stops.
//
// Server-only: imports `supabaseAdmin` lazily so nothing here can be pulled
// into a client bundle.

import { redactedError } from "@/lib/_server/redact";

// Saxo mints refresh tokens with a ~60 minute life and we rotate them every
// ~15 minutes, so a "short" window is the normal steady state — warning at 6h
// fired on every single healthy rotation. Only a window that has fallen below
// several rotation cycles (i.e. rotation has actually stopped working) is news.
const ROTATION_INTERVAL_MS = 15 * 60 * 1000;
const REFRESH_WINDOW_WARN_MS = 2.5 * ROTATION_INTERVAL_MS; // ~37 min
/** If rotation succeeded this recently, the short window is expected, not a fault. */
const RECENT_SUCCESS_MS = 2 * ROTATION_INTERVAL_MS; // 30 min

/** One failed rotation is enough — this is a money path, not noisy telemetry. */
const TOKEN_ALERT_THRESHOLD = 1;
const TOKEN_ALERT_WINDOW_MIN = 120;
const TOKEN_ALERT_COOLDOWN_MIN = 180;

export interface TokenRefreshOutcome {
  env: "sim" | "live";
  source: string;
  ok: boolean;
  skipped?: string | null;
  error?: unknown;
}

/**
 * Record the result of a token rotation attempt. Fire-and-forget: alerting
 * must never turn a broker hiccup into a failed cron run.
 */
export function recordTokenRefreshOutcome(outcome: TokenRefreshOutcome): void {
  void (async () => {
    try {
      const { supabaseAdmin } = await import(
        "@/integrations/supabase/client.server"
      );
      // Never persist the raw provider text — token endpoints echo the request
      // (and occasionally credentials) back in the error body.
      const safe = outcome.error ? redactedError(outcome.error) : null;

      if (outcome.ok) {
        await supabaseAdmin.from("broker_token_events").insert({
          env: outcome.env,
          source: outcome.source,
          ok: true,
          detail: outcome.skipped ?? null,
        });
        return;
      }

      await supabaseAdmin.from("broker_token_events").insert({
        env: outcome.env,
        source: outcome.source,
        ok: false,
        detail: safe?.message ?? "unknown error",
      });

      await supabaseAdmin.from("security_audit_log").insert({
        event: "broker_token",
        op: `${outcome.source}:${outcome.env}`,
        reason: "token_refresh_failed",
        details: { env: outcome.env, source: outcome.source, error: safe ? { ...safe } : null },
      });

      const { notifyAdminsSecurityEvent } = await import(
        "@/lib/security-alerts.server"
      );
      notifyAdminsSecurityEvent({
        event: "broker_token",
        reason: `${outcome.env}: ${safe?.message ?? "refresh failed"}`,
        title: "Broker token refresh failing",
        threshold: TOKEN_ALERT_THRESHOLD,
        windowMinutes: TOKEN_ALERT_WINDOW_MIN,
        cooldownMinutes: TOKEN_ALERT_COOLDOWN_MIN,
        details: { env: outcome.env, source: outcome.source },
      });
    } catch (e) {
      console.warn(
        "broker-token-health: record failed",
        redactedError(e).message,
      );
    }
  })();
}

/**
 * Escalate when the refresh-token window itself is closing: at that point no
 * amount of rotation helps and the owner has to reauthorize the broker link.
 */
export function checkRefreshWindow(params: {
  env: "sim" | "live";
  secondsUntilRefreshExpiry: number | null;
}): void {
  const secs = params.secondsUntilRefreshExpiry;
  if (secs == null) return;
  if (secs * 1000 > REFRESH_WINDOW_WARN_MS) return;
  void (async () => {
    try {
      const { supabaseAdmin } = await import(
        "@/integrations/supabase/client.server"
      );
      await supabaseAdmin.from("security_audit_log").insert({
        event: "broker_token",
        op: `refresh-window:${params.env}`,
        reason: secs <= 0 ? "refresh_token_expired" : "refresh_window_closing",
        details: { env: params.env, seconds_remaining: secs },
      });
      const { notifyAdminsSecurityEvent } = await import(
        "@/lib/security-alerts.server"
      );
      notifyAdminsSecurityEvent({
        event: "broker_token",
        reason:
          secs <= 0
            ? `${params.env}: refresh token expired — reconnect the broker`
            : `${params.env}: refresh token expires in ${Math.round(secs / 60)} min`,
        title: "Broker connection needs reauthorising",
        threshold: TOKEN_ALERT_THRESHOLD,
        windowMinutes: TOKEN_ALERT_WINDOW_MIN,
        cooldownMinutes: TOKEN_ALERT_COOLDOWN_MIN,
        details: { env: params.env, seconds_remaining: secs },
      });
    } catch (e) {
      console.warn(
        "broker-token-health: window check failed",
        redactedError(e).message,
      );
    }
  })();
}
