// Shared verification helper for the /api/public/hooks/* cron endpoints.
//
// Every public webhook MUST call `verifyCronRequest(request, { bucket, ... })`
// before touching any admin client. It bundles:
//   1. Per-IP token-bucket rate limit (see rate-limit.server).
//   2. Constant-time auth check using either the existing `x-cron-secret`
//      header or the canonical Lovable Cloud `apikey` header.
//   3. Uniform 401 / 429 responses so no route diverges.
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
  /** Optional override; defaults to process.env.SUPABASE_PUBLISHABLE_KEY. */
  expectedApiKey?: string;
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

export async function verifyCronRequest(
  request: Request,
  opts: VerifyCronOptions,
): Promise<VerifyCronResult> {
  const rl = await checkRateLimit(request, opts);
  if (!rl.allowed) return { ok: false, response: tooManyRequests(rl) };

  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("X-Cron-Secret") ??
    "";
  const expected = opts.expectedSecret ?? process.env.CRON_SECRET ?? "";
  const providedApiKey =
    request.headers.get("apikey") ??
    request.headers.get("ApiKey") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  const expectedApiKey =
    opts.expectedApiKey ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    "";

  const secretOk = Boolean(expected && provided && timingSafeEqual(provided, expected));
  const apiKeyOk = Boolean(expectedApiKey && providedApiKey && timingSafeEqual(providedApiKey, expectedApiKey));

  if (!secretOk && !apiKeyOk) {
    return { ok: false, response: jsonResponse(401, { error: "unauthorized" }) };
  }
  return { ok: true, ip: rl.ip };
}
