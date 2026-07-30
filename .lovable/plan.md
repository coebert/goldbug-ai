# Security review — Aegis (real-money trading app)

I audited the database access rules, every public endpoint, the server-side
trading paths, secret handling and the sign-in surface. The good news first,
then the issues in priority order.

## What's already solid

- Every user table has row-level access rules enabled, and the sensitive ones
  (portfolios, holdings, trades, orders, fills, equity history) are scoped to the
  owner. Audit/ledger tables are append-only.
- Broker tokens and the service key are never reachable from browser code; the
  project has a lint rule that blocks server-only modules from client bundles.
- One shared ownership check guards every privileged trading path, with a
  security audit log and push alerts on rejected access.
- Scheduled endpoints share one verification helper with constant-time
  comparison and per-IP rate limiting — no endpoint has a default-allow path.
- Global budget settings were just locked to an administrator role.

## Critical — fix first

**1. The public app key is accepted as a credential on the trading endpoints.**
The shared cron check accepts *either* the private `CRON_SECRET` *or* the
Supabase publishable key. That publishable key is, by design, public — it ships
inside the browser bundle of the published site. So anyone who opens the app can
read it and then call the endpoints that run the trading cycle, reconcile the
live account, or trigger reruns. Rate limiting slows that down; it does not stop
it. The same weak check is hardcoded in the equity-backfill endpoint.

Fix: require `CRON_SECRET` (or a new dedicated per-endpoint secret) on every
`/api/public/hooks/*` route, delete the publishable-key branch entirely, and
update the scheduled jobs to send the private header. Then verify each endpoint
returns 401 with only the public key.

**2. Trading endpoints have no second factor beyond one shared secret.**
Every job — hourly run, daily run, live reconcile, retrain — uses the same
secret. One leak (a log, a copied cron definition) exposes all of them,
including live order placement.

Fix: rotate `CRON_SECRET`, then give the order-placing routes their own secret,
add a short-lived signature (timestamp + HMAC, reject anything older than a few
minutes) so a captured request can't be replayed, and keep the existing per-IP
limits.

## High

**3. Sign-in hardening.** Turn on leaked-password checking so a password found
in a known breach is rejected, keep public signups off, and add a second factor
for the owner account. This account can move real money; a password alone is
thin.

**4. A "kill switch" that isn't reachable by an attacker.** Today a caller who
reached the run endpoints could place orders. Add a hard trading-enabled flag in
the database that only an administrator can flip, checked immediately before any
order is sent, plus a per-day notional ceiling enforced server-side and
independent of the strategy logic.

**5. Alert on the security audit log.** Rejected-access events are recorded but
mostly noticed only if someone looks. Route them to a push alert with a
threshold, and add the same for repeated 401s on the hook endpoints — that's the
signature of someone probing the secret.

## Medium

**6. Broker credential hygiene.** Move Saxo tokens onto a scheduled rotation and
alert if a refresh fails, so a stale or leaked token has a short life. Confirm no
broker response is written to a log table unredacted.

**7. Tighten the remaining flagged tables.** `market_open_alerts_sent`,
`run_locks` and `credit_budget_alerts` are currently closed by default, which is
correct; add explicit comments/policies so a future change can't accidentally
open them.

**8. Public news endpoint.** It's read-only and field-limited, which is fine, but
it queries with the privileged client. Switch it to the ordinary public client so
a future column addition can't leak anything beyond the public policy.

**9. Dependency and header hardening.** Add a regular dependency vulnerability
check, and set standard browser security headers (content policy, frame
blocking) on the published site.

## Suggested order of work

1. Remove the publishable-key auth branch on all hooks; rotate `CRON_SECRET`. (critical)
2. Add timestamped signatures + a dedicated secret for order-placing routes.
3. Enable leaked-password checks and a second factor for the owner account.
4. Add the admin-only trading kill switch and daily notional ceiling.
5. Wire alerts for rejected access and repeated 401s.
6. Broker token rotation + redaction audit.
7. Table comments/policies, public news client swap, headers, dependency scan.

## Technical notes

- Weak check lives in `src/lib/_server/cron.ts` (`expectedApiKey` branch) and is
  duplicated inline in `src/routes/api/public/hooks/backfill-daily-equity-changes.ts`.
- Order placement funnels through `src/lib/live-executor.server.ts`; that is the
  right chokepoint for the kill switch and notional ceiling.
- Ownership assertions are centralised in `src/lib/_server/ownership.ts` — keep
  new privileged paths going through it rather than re-checking inline.
- Sign-in settings are changed through the backend auth configuration, not code.

Tell me which items to implement and I'll start with the critical ones.
