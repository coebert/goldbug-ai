# `_server` — shared server-side primitives

Small, dependency-light helpers that codify cross-cutting concerns so every
`.server.ts` / cron route uses the same, audited implementation. Anything in
this directory is server-only — never import from routes/components at
module scope.

- `ownership.ts` — portfolio ownership assertions + structured security
  audit logging. Extracted from `execution-slicer.server.ts` (the reference
  implementation).
- `cron.ts` — `verifyCronRequest(request, bucket)` combines the
  `CRON_SECRET` check with the per-IP `consume_rate_limit` token bucket.
  Every `src/routes/api/public/hooks/*` handler MUST go through it.
- `redact.ts` — `redactedError(e)` for third-party HTTP failures (Saxo,
  Yahoo, GDELT). Keeps status/name, strips payload fragments before they
  hit logs.
