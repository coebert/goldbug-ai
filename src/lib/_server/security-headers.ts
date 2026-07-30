/**
 * Browser security headers for every server-rendered response.
 *
 * Extracted from `src/start.ts` so CI can assert the exact policy (see
 * `src/lib/_server/__tests__/security-headers.contract.test.ts`). Loosening
 * anything here fails the build unless the contract test is updated too —
 * that friction is intentional for a real-money app.
 *
 * The CSP is deliberately permissive on `script-src` (`'unsafe-inline'` +
 * `'unsafe-eval'`) because the Vite/React Start runtime and the preview
 * tooling both inject inline bootstrap scripts; the value here still blocks
 * third-party script origins, object/plugin embedding, and framing of the app
 * (clickjacking), which is what matters for a real-money account.
 */
export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self' https://*.lovable.app https://*.lovable.dev https://lovable.dev",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.lovable.app https://*.lovable.dev",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
] as const;

export const CSP = CSP_DIRECTIVES.join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin-allow-popups",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

/** Apply the policy to a response without clobbering an explicit override. */
export function applySecurityHeaders(headers: Headers): Headers {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}
