// Shared verification helper for the /api/public/hooks/* cron endpoints.
//
// Every public webhook MUST call `verifyCronRequest(request, { bucket, ... })`
// before touching any admin client. It bundles:
//   1. Per-IP token-bucket rate limit (see rate-limit.server).
//   2. Constant-time auth check against the PRIVATE `CRON_SECRET`.
//   3. Optional timestamped HMAC signature for the money-moving routes.
//   4. Uniform 401 / 429 responses so no route diverges.
//   5. A persisted `cron_auth` security event on every rejection, so repeated
//      probing raises a push alert instead of sitting silently in the logs.
//
// SECURITY — do NOT reintroduce an `apikey` / publishable-key branch here.
// The Supabase publishable key is shipped inside the browser bundle of the
// published site, so accepting it as a credential makes these endpoints (which
// place real broker orders) callable by anyone who opens the app. The private
// `CRON_SECRET` is the only accepted bearer, and pg_cron reads it from the
// vault.
//
// Returning `{ ok: false, response }` means the handler must return
// `response` unchanged. `{ ok: true }` means the caller is verified.
//
// The helper is designed so a route that forgets to call it fails obviously:
// there is no default-allow path.

import {
  checkRateLimit,
  tooManyRequests,
  type RateLimitOptions,
} from "@/lib/rate-limit.server";

export interface VerifyCronOptions extends RateLimitOptions {
  /** Optional override; defaults to process.env.CRON_SECRET. */
  expectedSecret?: string;
  /**
   * Require `x-cron-timestamp` + `x-cron-signature` in addition to the shared
   * secret. Use on every endpoint that can place or reconcile real orders: it
   * binds the request to a single path and a short time window, so a captured
   * request cannot be replayed or pointed at a different endpoint.
   */
  requireSignature?: boolean;
  /** Accepted clock skew for signed requests, in seconds (default 300). */
  maxSkewSeconds?: number;
}

export type VerifyCronResult =
  | { ok: true; ip: string }
  | { ok: false; response: Response };

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Constant-time string compare — avoids leaking secret length via timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** Hex HMAC-SHA256 over `${timestamp}.${pathname}`, keyed with CRON_SECRET. */
async function signPayload(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Probes within this window are counted towards the alert threshold. */
const AUTH_ALERT_WINDOW_MIN = 15;
const AUTH_ALERT_THRESHOLD = 5;
const AUTH_ALERT_COOLDOWN_MIN = 60;

/**
 * Record a rejected webhook call and, when someone is clearly probing, notify
 * every admin. Fire-and-forget: an audit failure must never turn a clean 401
 * into a 500.
 */
function auditAuthFailure(context: {
  bucket: string;
  ip: string;
  path: string;
  reason: string;
}): void {
  console.warn("SECURITY:cron_auth rejected webhook call", context);
  void (async () => {
    try {
      const { supabaseAdmin } = await import(
        "@/integrations/supabase/client.server"
      );
      await supabaseAdmin.from("security_audit_log").insert({
        event: "cron_auth",
        op: context.bucket,
        reason: context.reason,
        details: { ip: context.ip, path: context.path },
      });

      // Shared admin fan-out: in-app notification + push, threshold + cooldown.
      const { notifyAdminsSecurityEvent } = await import(
        "@/lib/security-alerts.server"
      );
      notifyAdminsSecurityEvent({
        event: "cron_auth",
        reason: context.reason,
        threshold: AUTH_ALERT_THRESHOLD,
        windowMinutes: AUTH_ALERT_WINDOW_MIN,
        cooldownMinutes: AUTH_ALERT_COOLDOWN_MIN,
        details: { ip: context.ip, path: context.path },
      });
    } catch {
      /* best-effort */
    }
  })();
}


/**
 * Secrets accepted right now, most-current first.
 *
 * ROTATION (zero downtime): set `CRON_SECRET_NEXT` to the new value and point
 * the scheduler vault at it. Both the old and the new value are accepted while
 * the overlap window is open, so a deploy/vault update in either order cannot
 * drop a scheduled run. Once every job has run cleanly on the new value,
 * promote it to `CRON_SECRET` and delete `CRON_SECRET_NEXT`.
 */
function acceptedSecrets(opts: VerifyCronOptions): string[] {
  if (opts.expectedSecret) return [opts.expectedSecret];
  return [process.env.CRON_SECRET, process.env.CRON_SECRET_NEXT].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
}

export async function verifyCronRequest(
  request: Request,
  opts: VerifyCronOptions,
): Promise<VerifyCronResult> {
  const rl = await checkRateLimit(request, opts);
  if (!rl.allowed) return { ok: false, response: tooManyRequests(rl) };

  const path = new URL(request.url).pathname;
  const reject = (reason: string): VerifyCronResult => {
    auditAuthFailure({ bucket: opts.bucket, ip: rl.ip, path, reason });
    return { ok: false, response: jsonResponse(401, { error: "unauthorized" }) };
  };

  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("X-Cron-Secret") ??
    "";
  const candidates = acceptedSecrets(opts);

  if (candidates.length === 0) return reject("cron_secret_not_configured");
  // Constant-time compare against every accepted value; the matched one is the
  // key the signature must verify under.
  let matched: string | null = null;
  for (const c of candidates) {
    if (provided && timingSafeEqual(provided, c)) matched = c;
  }
  if (!matched) return reject("bad_or_missing_secret");

  const timestamp =
    request.headers.get("x-cron-timestamp") ??
    request.headers.get("X-Cron-Timestamp") ??
    "";
  const signature =
    request.headers.get("x-cron-signature") ??
    request.headers.get("X-Cron-Signature") ??
    "";

  // A signature is mandatory on high-risk routes, and always verified when
  // present — an attacker cannot downgrade by omitting a valid one.
  if (opts.requireSignature || timestamp || signature) {
    if (!timestamp || !signature) return reject("missing_signature");

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return reject("bad_timestamp");
    const skew = Math.abs(Date.now() / 1000 - ts);
    if (skew > (opts.maxSkewSeconds ?? 300)) return reject("stale_signature");

    const want = await signPayload(matched, `${timestamp}.${path}`);
    if (!timingSafeEqual(signature.toLowerCase(), want)) {
      return reject("bad_signature");
    }
  }

  return { ok: true, ip: rl.ip };
}

