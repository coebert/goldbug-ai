/**
 * Browser security headers, per endpoint class.
 *
 * Extracted from `src/start.ts` so CI can assert the exact policy (see
 * `src/lib/_server/__tests__/security-headers.contract.test.ts`). Loosening
 * anything here fails the build unless the contract test is updated too —
 * that friction is intentional for a real-money app.
 *
 * Three policies, because a JSON endpoint needs nothing that an HTML document
 * needs:
 *
 *   - `document` — the app shell. Sources are enumerated from what the client
 *     actually loads: same-origin bundles, Google Fonts, `data:` (the MFA QR
 *     code), and the Supabase project origin over https + wss (realtime).
 *   - `api`      — `/api/*`. Returns JSON; every fetch/render directive is
 *     denied outright via `default-src 'none'`.
 *   - `asset`    — hashed build output. No fetch directives apply, so it only
 *     carries the transport/sniffing headers.
 *
 * Deliberate omissions (they'd be dead weight):
 *   - `worker-src`, `manifest-src`, `media-src`, `child-src` — all inherit
 *     `default-src 'self'`, which is already exactly what we want.
 *   - `blob:` in `img-src` — the only object URL we create is an anchor
 *     download in `audit-log.ts`, which CSP fetch directives don't govern.
 *   - `https:` wildcards in `img-src`/`connect-src` — no third-party image or
 *     XHR origin is used from the browser; all market data is fetched server
 *     side. A wildcard here would defeat the point of having a CSP at all.
 */

const IS_PROD = import.meta.env?.PROD ?? process.env.NODE_ENV === "production";

/** Supabase project origin (https) — the only cross-origin XHR/ws target. */
function supabaseOrigins(): string[] {
  const raw =
    (typeof import.meta !== "undefined" && import.meta.env?.VITE_SUPABASE_URL) ||
    process.env.SUPABASE_URL ||
    "";
  try {
    const { origin, host } = new URL(raw);
    return [origin, `wss://${host}`];
  } catch {
    // No env at build time (tests/tooling): fall back to the project domain.
    return ["https://*.supabase.co", "wss://*.supabase.co"];
  }
}

/**
 * Preview/editor origins are only needed when Lovable frames the app and
 * injects its tooling. Production serves nothing from them.
 */
const LOVABLE_ORIGINS = [
  "https://*.lovable.app",
  "https://*.lovable.dev",
  "https://lovable.dev",
];

export function buildDocumentCsp(prod: boolean = IS_PROD): string[] {
  const [supabaseHttps, supabaseWs] = supabaseOrigins();

  // TanStack Start hydrates through an inline bootstrap script, so
  // 'unsafe-inline' stays. 'unsafe-eval' is a dev-only concession to the Vite
  // HMR runtime — the production bundle never evals.
  const script = [
    "script-src",
    "'self'",
    "'unsafe-inline'",
    ...(prod ? [] : ["'unsafe-eval'", ...LOVABLE_ORIGINS]),
  ].join(" ");

  const connect = [
    "connect-src",
    "'self'",
    supabaseHttps,
    supabaseWs,
    ...(prod ? [] : ["ws:", "wss:", ...LOVABLE_ORIGINS]),
  ].join(" ");

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    `frame-ancestors 'self' ${LOVABLE_ORIGINS.join(" ")}`,
    "form-action 'self'",
    script,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    connect,
    // Dev serves over plain http on localhost and HMR uses ws:; upgrading
    // those would break the dev server for no security gain.
    ...(prod ? ["upgrade-insecure-requests"] : []),
  ];
}

/** JSON endpoints render nothing and fetch nothing. */
export const API_CSP_DIRECTIVES = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
] as const;

export const CSP_DIRECTIVES = buildDocumentCsp();
export const CSP = CSP_DIRECTIVES.join("; ");
export const API_CSP = API_CSP_DIRECTIVES.join("; ");

/** Transport/sniffing headers — identical for every endpoint class. */
export const BASE_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

const DOCUMENT_ONLY_HEADERS: Record<string, string> = {
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin-allow-popups",
};

export type EndpointClass = "document" | "api" | "asset";

/** Classify a request path into the policy that should apply to it. */
export function classifyEndpoint(pathname: string): EndpointClass {
  if (pathname.startsWith("/api/")) return "api";
  if (/^\/(assets|_build|favicon\.png|icon-(192|512)\.png|apple-touch-icon\.png|sw-push\.js|manifest\.webmanifest)/.test(pathname)) {
    return "asset";
  }
  return "document";
}

/** The full header set for one endpoint class. */
export function headersFor(kind: EndpointClass): Record<string, string> {
  if (kind === "api") {
    return { ...BASE_HEADERS, "content-security-policy": API_CSP };
  }
  if (kind === "asset") return { ...BASE_HEADERS };
  return { ...BASE_HEADERS, ...DOCUMENT_ONLY_HEADERS, "content-security-policy": CSP };
}

/**
 * Back-compat alias: the document policy, which is what `SECURITY_HEADERS`
 * meant before per-endpoint policies existed.
 */
export const SECURITY_HEADERS: Record<string, string> = headersFor("document");

/** Apply the right policy to a response without clobbering explicit values. */
export function applySecurityHeaders(headers: Headers, pathname = "/"): Headers {
  for (const [name, value] of Object.entries(headersFor(classifyEndpoint(pathname)))) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}
