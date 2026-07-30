# `_server` — shared server-side primitives

Small, dependency-light helpers that codify cross-cutting concerns so every
`.server.ts` / cron route uses the same, audited implementation. Anything in
this directory is server-only — never import from routes/components at
module scope.

- `ownership.ts` — portfolio ownership assertions + structured security
  audit logging. Extracted from `execution-slicer.server.ts` (the reference
  implementation).
- `cron.ts` — `verifyCronRequest(request, opts)` combines the private
  `CRON_SECRET` check (constant-time), the per-IP `consume_rate_limit` token
  bucket, an optional timestamped HMAC signature (`requireSignature: true` on
  every money-moving route) and an audited 401 that alerts admins on repeated
  probing. Every `src/routes/api/public/hooks/*` handler MUST go through it.
  NEVER accept the Supabase publishable key here — it ships in the browser
  bundle.
- `redact.ts` — `redactedError(e)` for third-party HTTP failures (Saxo,
  Yahoo, GDELT). Keeps status/name, strips payload fragments before they
  hit logs.
