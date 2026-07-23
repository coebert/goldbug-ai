// Per-IP token-bucket rate limiter backed by Postgres (`consume_rate_limit`).
// Used to blunt the blast radius of a leaked CRON_SECRET on the public
// /api/public/hooks/* endpoints.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export interface RateLimitOptions {
  /** Logical bucket name, e.g. "hooks:daily-run". */
  bucket: string;
  /** Max tokens in the bucket (also the initial fill). */
  capacity: number;
  /** Tokens replenished per second. */
  refillPerSec: number;
  /** Cost of this request (default 1). */
  cost?: number;
}

function clientIp(request: Request): string {
  const headers = request.headers;
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf;
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  const real = headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
  ip: string;
  key: string;
}

/** Consume a token from the caller's bucket. Fails open if the RPC errors. */
export async function checkRateLimit(
  request: Request,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const ip = clientIp(request);
  const key = `${opts.bucket}:${ip}`;
  try {
    const { data, error } = await supabaseAdmin.rpc("consume_rate_limit", {
      _key: key,
      _capacity: opts.capacity,
      _refill_per_sec: opts.refillPerSec,
      _cost: opts.cost ?? 1,
    });
    if (error) {
      console.warn("rate-limit rpc error, failing open", key, error.message);
      return { allowed: true, remaining: opts.capacity, retryAfter: 0, ip, key };
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
      allowed: Boolean(row?.allowed),
      remaining: Number(row?.remaining ?? 0),
      retryAfter: Number(row?.retry_after ?? 0),
      ip,
      key,
    };
  } catch (e) {
    console.warn("rate-limit exception, failing open", key, e);
    return { allowed: true, remaining: opts.capacity, retryAfter: 0, ip, key };
  }
}

/** Build a 429 Response with Retry-After when a bucket is exhausted. */
export function tooManyRequests(result: RateLimitResult): Response {
  const retry = Math.max(1, Math.ceil(result.retryAfter));
  return new Response(
    JSON.stringify({ error: "rate_limited", retry_after_seconds: retry }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retry),
      },
    },
  );
}
