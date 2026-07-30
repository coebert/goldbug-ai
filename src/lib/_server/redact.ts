// Redacts third-party errors (Saxo, Yahoo, GDELT, etc.) before they hit
// logs. Response bodies from broker APIs frequently echo request payloads
// (account ids, order params, sometimes tokens); a raw `console.error(e)`
// leaks those into log storage. Route every catch block that logs a
// provider failure through `redactedError`.

export interface RedactedError {
  name: string;
  message: string;
  status?: number;
}

const SENSITIVE_KEY_RE =
  /(token|secret|key|password|authorization|cookie|session|apikey)/i;
const LONG_HEX_RE = /[a-f0-9]{24,}/gi;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._-]+/gi;
// JWT-shaped values (Saxo/Supabase access tokens) and any long opaque
// base64url blob — broker token endpoints echo these back in error bodies.
const JWT_RE = /\beyJ[A-Za-z0-9._-]{10,}/g;
const LONG_B64_RE = /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g;
// `refresh_token=...`, `"access_token":"..."` style pairs in raw payloads.
const KV_SECRET_RE =
  /((?:access|refresh|id)?_?(?:token|secret|password|apikey|api_key)"?\s*[:=]\s*"?)([^"&,\s}]+)/gi;

function redactString(s: string): string {
  return s
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(KV_SECRET_RE, "$1[redacted]")
    .replace(JWT_RE, "[redacted]")
    .replace(LONG_HEX_RE, "[redacted]")
    .replace(LONG_B64_RE, "[redacted]");
}


function redactValue(v: unknown, depth = 0): unknown {
  if (depth > 3) return "[truncated]";
  if (typeof v === "string") return redactString(v);
  if (Array.isArray(v)) return v.slice(0, 10).map((x) => redactValue(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redactValue(val, depth + 1);
    }
    return out;
  }
  return v;
}

/**
 * Convert any thrown value into a safe `{ name, message, status? }` shape.
 * The `message` never contains bearer tokens, long hex strings, or values
 * of sensitive-looking keys.
 */
export function redactedError(e: unknown): RedactedError {
  if (e instanceof Error) {
    const status =
      (e as unknown as { status?: number }).status ??
      (e as unknown as { statusCode?: number }).statusCode;
    return {
      name: e.name || "Error",
      message: redactString(e.message ?? String(e)),
      ...(typeof status === "number" ? { status } : {}),
    };
  }
  if (typeof e === "string") return { name: "Error", message: redactString(e) };
  const value = redactValue(e);
  return { name: "Error", message: JSON.stringify(value) };
}
