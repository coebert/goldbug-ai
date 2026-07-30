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

## Rotating `CRON_SECRET` (zero downtime)

1. Set `CRON_SECRET_NEXT` to the new random value (app now accepts old **and** new).
2. Update the `CRON_SECRET` entry in the database vault to the same new value —
   pg_cron reads it there for both the plain header and the HMAC signature.
3. Verify: a signed and an unsigned scheduled call both return 200.
4. Promote the new value to `CRON_SECRET` and delete `CRON_SECRET_NEXT`.

Never leave `CRON_SECRET_NEXT` set long-term; it exists only for the overlap window.

## Broker credential hygiene (phase 6)

- Saxo tokens rotate on a schedule (`/api/public/hooks/saxo-refresh` every
  ~30 min, plus the hourly tick preflight). Every attempt reports through
  `recordTokenRefreshOutcome` in `src/lib/broker-token-health.server.ts`,
  which appends to `broker_token_events` (admin-read, append-only) and, on
  failure, audits a `broker_token` event and pushes an admin alert.
- `checkRefreshWindow` escalates separately when the *refresh* token window is
  closing (< 6h) or has lapsed — at that point only a reauthorisation helps.
- Redaction is mandatory on any provider text that reaches a log or a table:
  route it through `redactedError` (`_server/redact.ts`). It strips bearer
  tokens, JWT-shaped values, long hex/base64 blobs and
  `access_token=/refresh_token=`-style pairs. The Saxo REST error path and the
  OAuth token-exchange path both redact before logging or throwing.

## Surface hardening (phase 7)

- Browser security headers (CSP, nosniff, referrer policy, permissions policy,
  COOP, HSTS) are applied to every SSR response by `securityHeadersMiddleware`
  in `src/start.ts`. Add new third-party origins to the CSP there rather than
  loosening `default-src`.
- Internal tables (`run_locks`, `market_open_alerts_sent`,
  `rate_limit_buckets`) keep RLS on with **no** policies; each carries a table
  comment saying so. `consume_rate_limit` and the other SECURITY DEFINER
  helpers are service_role-only except `has_role`, which RLS needs.
- Dependency vulnerability scanning is run as part of each security pass.

## Server-side two-factor (phase 8)

- `requireAal2` (`src/lib/_server/require-aal2.ts`) wraps `requireSupabaseAuth`
  and rejects any bearer token whose session is not `aal2` **once the account
  has a verified factor**. Accounts with no factor pass through, so enrolment
  is never a lockout.
- Applied to the money-moving/irreversible server functions: `manualSellHolding`,
  `triggerHourlyRunNow`, `updateTradingControls`, `activateLive`,
  `resumeAllLive`, `startSaxoOAuth`, `deletePortfolio`. Risk-reducing actions
  (pause, kill-all, deactivate) stay single-factor on purpose — never make
  stopping trading harder than starting it.
- New privileged server functions should use `requireAal2`, not
  `requireSupabaseAuth`.

## CI security gates

`bun run verify:security` (also `.github/workflows/security.yml`, on every push/PR
plus a daily cron) runs three blocking checks:

1. **Security headers** — `check:security-headers` locks the SSR policy in
   `security-headers.ts`: required headers present, HSTS >= 1 year with
   subdomains, no wildcard/`http:` source, no `unsafe-eval` or editor origins in
   production, `connect-src` scoped to self + the backend origin, and no
   directive that merely repeats the `default-src` fallback. Loosening the
   policy fails CI until the contract test is updated in the same commit.

   The policy is **per endpoint class** (`classifyEndpoint`):
   `/api/*` gets `default-src 'none'` (JSON renders and fetches nothing),
   hashed assets get transport headers only, and documents get the app CSP.
   Sources are enumerated from what the client actually loads — same-origin
   bundles, Google Fonts, `data:` for the MFA QR, and the Supabase origin over
   https + wss. Dev additionally allows `unsafe-eval`, `ws:` and the Lovable
   editor origins for HMR; production has none of them, and only production
   sends `upgrade-insecure-requests`.
2. **Dependency scan** — `check:deps` fails on any high/critical advisory.
   CI runs it with `--strict`, so an unreachable advisory registry is a failure
   rather than a silent pass.
3. **SECURITY DEFINER constraints** — `check:security-definer` statically audits
   every definer function in `supabase/migrations`: `search_path` must be pinned,
   EXECUTE must never reach `PUBLIC`/`anon`, and anything not on the reviewed
   allowlist must carry an explicit `REVOKE ALL` and be `service_role` only.
   New definer functions require an allowlist entry — that is the review gate.
