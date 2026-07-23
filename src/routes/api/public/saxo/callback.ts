// Saxo OAuth callback. Receives ?code&state, verifies HMAC state, exchanges
// the code for tokens, persists them, and shows a small success/failure page.
// Public prefix bypasses auth on published sites; security = HMAC state + Saxo
// only redirecting to registered URI + code exchange requires client secret.

import { createFileRoute } from "@tanstack/react-router";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function param(url: URL, ...names: string[]): string | null {
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value) return value;
  }
  return null;
}

function diagnosticList(url: URL): string {
  const allowed = ["error", "error_description", "message", "state"];
  const items = allowed
    .map((key) => {
      const value = url.searchParams.get(key);
      return value ? `<li><strong>${escapeHtml(key)}</strong>: ${escapeHtml(value)}</li>` : "";
    })
    .filter(Boolean)
    .join("");
  return items ? `<ul>${items}</ul>` : "";
}

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Saxo OAuth</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0d10;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#11141a;border:1px solid #1f242c;border-radius:12px;padding:32px;max-width:520px;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.4)}
h1{margin:0 0 12px;font-size:20px}p{margin:8px 0;color:#9ca3af;line-height:1.5}
ul{margin:14px 0;padding-left:18px;text-align:left;color:#cbd5e1}li{margin:6px 0}
a{color:#60a5fa;text-decoration:none}a:hover{text-decoration:underline}
.ok{color:#34d399}.err{color:#f87171}</style></head>
<body><div class="card">${body}</div></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export const Route = createFileRoute("/api/public/saxo/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = param(url, "code", "Code", "authorization_code", "AuthorizationCode");
        const state = param(url, "state", "State");
        const err = param(url, "error", "Error");
        const description = param(url, "error_description", "ErrorDescription", "message", "Message");
        if (err) {
          return html(
            `<h1 class="err">Saxo authorization failed</h1>
             <p>${escapeHtml(description ?? err)}</p>
             ${diagnosticList(url)}
             <p><a href="/admin">Back to Admin</a></p>`,
            400,
          );
        }
        if (!code || !state) {
          return html(
            `<h1 class="err">Saxo did not return a complete authorization response</h1>
             <p>Please start again from <strong>Admin → Connect (LIVE)</strong>. If this repeats, the LIVE Saxo app is redirecting without the required OAuth code/state parameters.</p>
             <p>Check the LIVE app's redirect URL is exactly:</p>
             <p><code>https://goldbug-ai.lovable.app/api/public/saxo/callback</code></p>
             ${diagnosticList(url)}
             <p><a href="/admin">Back to Admin</a></p>`,
            400,
          );
        }
        const { verifyState, exchangeAuthorizationCode } = await import(
          "@/lib/brokers/saxo-oauth.server"
        );
        const verified = verifyState(state);
        if (!verified) {
          return html(`<h1 class="err">Invalid or expired state</h1><p>Please restart the connect flow from Admin and complete the Saxo login within 15 minutes.</p><p><a href="/admin">Back to Admin</a></p>`, 400);
        }
        try {
          await exchangeAuthorizationCode(verified.env, code);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return html(`<h1 class="err">Token exchange failed</h1><p>${escapeHtml(msg)}</p><p><a href="/admin">Back to Admin</a></p>`, 502);
        }
        return html(
          `<h1 class="ok">✓ Saxo connected (${verified.env.toUpperCase()})</h1>
           <p>Tokens stored. The app will auto-refresh access from now on.</p>
           <p><a href="/admin">Return to Admin</a></p>`,
        );
      },
    },
  },
});
