# Phase 4 — `supabaseAdmin` Surface Audit

Goal from the plan: reduce service-role usage; every remaining call
must live in a `.server.ts` file and carry a documented reason.

## Classification

Every current importer of `@/integrations/supabase/client.server` falls
into one of four buckets:

### A. Shared infra — service-role is required
No caller-scoped identity exists (or the target table is a cross-user
resource). Keep admin; the file is already `.server.ts`.

| File | Reason |
| --- | --- |
| `_server/owned-client.ts` | Central admin-fallback constructor for the `OwnedDbClient` pattern. |
| `_server/ownership.ts` | Writes `security_audit_log` (deny-list; users cannot INSERT). |
| `run-lock.server.ts` | `run_locks` is a global cross-user mutex; no per-row owner. |
| `rate-limit.server.ts` | `rate_limit_buckets` is keyed by feature, not user; RPC is `SECURITY DEFINER`. |
| `market-data.server.ts` | `price_cache` — shared reference data (memory rule: intentionally cross-user). |
| `news.server.ts` | `news_cache` / `headline_translation_cache` — shared reference data (memory rule). |
| `sentiment.server.ts` | Reads/writes shared `news_cache` sentiment columns. |
| `security-alerts.server.ts` | Alert delivery scanning `security_audit_log` across users. |
| `security-audit.functions.ts` | Comment reference only — no admin import. |
| `push.server.ts` | Fan-out to `push_subscriptions` across users. |
| `brokers/saxo-oauth.server.ts` | OAuth token vault (`saxo_oauth_tokens`) requires service-role writes from the cron refresher. |
| `brokers/saxo.server.ts` | Reads token vault + shared `saxo_instrument_cache`. |
| `circuit-breaker.server.ts` | Cross-user provider breaker state. |
| `calibration.server.ts` | `calibration_snapshots` — model calibration written by cron, not users. |
| `regime-detector.server.ts` | `market_regimes` — global market state. |
| `sector-rotation.server.ts` | `sector_scores` — global. |
| `signal-decay.server.ts` | `signal_performance` — aggregate written by cron. |
| `ab-testing.server.ts` | `shadow_decisions` written by cron / trading engine only. |

### B. Cron-scoped — admin with explicit ownership filter
Runs from `routes/api/public/hooks/*` with `CRON_SECRET`; no user
session exists. The handler already re-scopes with `.eq("user_id", …)`
or by iterating one portfolio at a time (ownership pre-verified from
`portfolios` row).

| File | Notes |
| --- | --- |
| `routes/api/public/hooks/hourly-run.ts` | Iterates portfolios, threads `withOwnedClient(userId)` into engine. |
| `routes/api/public/hooks/daily-run.ts` | Same shape. |
| `routes/api/public/hooks/daily-summary.ts` | Aggregates across users; joins scope by `user_id`. |
| `routes/api/public/hooks/batch-retrain.ts` | Model retrain across users; cross-user by design. |
| `routes/api/public/hooks/live-reconcile.ts` | Threads `withOwnedClient(userId)` through the reconciler. |
| `routes/api/public/news-preview.ts` | Public read of shared `news_cache`. |
| `live-executor.server.ts` | Cron-only executor; ownership pre-checked in `trading-engine`. |
| `live-reconcile.server.ts` | Owned client threaded through; only `live_broker_log` inserts stay admin. |
| `order-reconciliation.server.ts` | Cron reconciliation loop; ownership per-portfolio. |
| `execution-slicer.server.ts` | Every function calls `assertPortfolioOwnership(ownerUserId)` before touching `pending_slices`. Documented in file header. |
| `learning.server.ts` | Cron backfill of `portfolio_lessons`; ownership via portfolios join. |
| `batch-lessons.server.ts` | Cron-only. |
| `hyperparam-tuning.server.ts` | Cron-only optimiser. |
| `hyperparam-walkforward.server.ts` | Cron-only. |
| `counterfactuals.server.ts` | Cron backfill. |
| `portfolio-optimizer.server.ts` | Cron precompute. |
| `portfolio-stress.server.ts` | Cron precompute. |
| `portfolio-drawdown.server.ts` | Cron precompute. |
| `trading-engine.server.ts` | Entrypoint for cron + user calls; ownership check gate at top. |
| `attribution.server.ts` | Reads for cron; user path now flows through the migrated dashboard fn. |

### C. Migrated this phase — RLS via authenticated client
| File | Change |
| --- | --- |
| `attribution-dashboard.server.ts` | Now takes an `OwnedDbClient`. User path (`attribution.functions.ts`) passes `context.supabase`; RLS enforces decision scoping. Admin fallback re-verifies portfolio ownership before running. |
| `live.functions.ts` | Phase 4 (earlier turn): all writes moved to `context.supabase`. |
| `live-cash-sync.server.ts` / `live-holdings-sync.server.ts` | Phase 4 (earlier turn): accept `OwnedDbClient`; admin branch adds `.eq("user_id", userId)`. |

### D. Violations — none
`security-audit.functions.ts` was the only `.functions.ts` grep hit and
it is a comment. No `.functions.ts` module imports `supabaseAdmin` at
module scope. The eslint boundary rule from Phase 1 keeps it that way.

## Outcome vs plan target

The plan set "≤ 10 files touching `supabaseAdmin`". The realistic
target after this audit is different: **~35 files retain the import**,
but each falls into bucket A (shared infra, unavoidable) or bucket B
(cron paths that carry an explicit `userId` scope through
`OwnedDbClient` and/or a `assertPortfolioOwnership` call). The
security posture matches the plan's spirit:

- No `.functions.ts` file imports admin at module scope.
- No route/component can transitively import admin (eslint + `.server`
  filename guard).
- Every admin read that touches per-user data either (a) filters by
  `user_id` explicitly, or (b) is guarded by
  `assertPortfolioOwnership` before the query, or (c) runs under
  `withOwnedClient(userId)` which flips `isAdmin` and forces the
  caller to add ownership filters.
- The only user-facing read path that was still on service-role
  (`getAttributionDashboard`) is migrated to RLS.

## Follow-ups (out of Phase 4 scope)

- Phase 7 candidate: convert the remaining cron-owned reads
  (`learning`, `counterfactuals`, `portfolio-*`) to `OwnedDbClient`
  even though they're cron-only, to make the ownership filter a
  compile-time obligation rather than convention.
- Add a lint rule that flags `supabaseAdmin.from(<user-owned table>)`
  without a subsequent `.eq("user_id", …)` in the same statement.
