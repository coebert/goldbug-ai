# Codebase Review & Improvement Plan

A comprehensive review of Aegis. The app works well and has strong test coverage, but has grown organically: a handful of files are very large, server/client boundaries are inconsistently applied, and cross-cutting concerns (auth, logging, ownership, rate limits) are re-implemented per module. Below is what I found and a phased plan to fix it without behavioural changes.

## What's already good

- Clear split of `.server.ts` / `.functions.ts` / client modules with import guards.
- Zod validation at server-function boundaries (see `execution-slicer-*` — this is the gold standard to copy).
- Strong test suite (fuzz, e2e, contract, visual, property, snapshot).
- RLS + `has_role` pattern, dedicated `user_roles`, security audit log, security memory doc.
- Idempotency keys on slicer, run-lock table, rate-limit token bucket function.

## Key issues found

### 1. Mega-files hurting maintainability
- `src/lib/trading.functions.ts` — **2,802 lines**, **34 server functions**. Single file owns backtest, live, sim, retrain, config, metrics, and holdings orchestration.
- `src/lib/trading-engine.server.ts` — 1,396 lines mixing signal generation, sizing, execution routing.
- `src/routes/portfolio.$id.tsx` — **1,866 lines**; `src/routes/index.tsx` — 1,293.
- `src/components/news-reel.tsx` (962), `live-trading-card.tsx` (788), `backtest-run-history-card.tsx` (709), `risk-controls-card.tsx` (656).

These are hard to review, slow to typecheck, and easy to regress. They also inflate route tree types (TanStack infers loader return types across all server fns pulled in).

### 2. Server/client boundary drift
- 37 files under `src/lib/` import `supabaseAdmin`. Some are `.server.ts` (correct), but any `.functions.ts` that imports admin at module scope leaks into the client bundle chain via handler stubs. Needs an audit + dynamic `await import('@/integrations/supabase/client.server')` inside handlers only.
- Several `.functions.ts` likely still contain sibling helpers/config next to `createServerFn` (violates `tss-serverfn-split` — causes `ReferenceError` at runtime post-transform). The slicer module was already refactored — apply the same shape everywhere.

### 3. Repeated ownership + auth boilerplate
Every server fn re-does: `requireSupabaseAuth` → look up portfolio → check `user_id === context.userId` → log to security audit. The slicer's `assertPortfolioOwnership` + `logUnexpectedAccess` is the right pattern, but it's copy-pasted (with variations) across trading, live, holdings-history, attribution, insights, etc. Small drift here is a security risk.

### 4. Security posture — real risks
- **Public webhook routes** under `src/routes/api/public/hooks/*` (daily-run, hourly-run, batch-retrain, live-reconcile, saxo-refresh, translation-refresh). They should all: (a) verify `CRON_SECRET` in constant time, (b) enforce a rate limit via `consume_rate_limit`, (c) never echo input in errors. Needs a shared `verifyCronRequest()` helper so no route can forget.
- **Service-role usage is broad** (37 files). Every admin-client call needs a documented reason — "reading own row" should use the RLS'd client instead. Reducing the admin surface area is the single highest-leverage security win.
- **CORS / headers**: no evidence of a shared response-hardening layer (CSP, X-Content-Type-Options, Referrer-Policy). Add via server route middleware.
- **Input validation coverage**: only a subset of server fns use Zod. Make Zod `.inputValidator` mandatory (lint rule or code review checklist).
- **Password HIBP check**: verify `password_hibp_enabled` is on (`configure_auth`). Given single-user app it's low risk but trivial to enable.
- **Error surfaces**: raw provider errors from Saxo/Yahoo/GDELT sometimes bubble to logs with payload fragments. Wrap in a `redactedError()` helper.

### 5. Elegance / consistency
- Two overlapping formatting stacks (`portfolio-performance-format.ts` + ad-hoc `Intl.NumberFormat` in route files). Contract test locks one — route-level formatters should go through it.
- `uk-time.ts` was added recently but multiple call sites still build `Intl.DateTimeFormat` inline. Migrate them all.
- Route files fetch, format, chart, and manage local state in one component. Extract page-level containers + presentational components.
- Local-storage-esque event bus (`aegis:backtest-runs-updated`) works but React Query `invalidateQueries` after the mutation is cleaner.
- `as unknown as never` casts on Supabase inserts are a smell — regenerate types or use narrower helper wrappers.

### 6. Tooling / DX
- No ESLint rule preventing `supabaseAdmin` imports outside `*.server.ts`.
- No boundary rule preventing `.server.ts` imports from route/component files.
- Route tree type is large; several loaders return full Query results instead of `void`.
- No pre-commit typecheck/lint script visible; test suite is heavy — split unit vs e2e.

## Phased plan

### Phase 1 — Safety net (no behaviour change)
1. Add ESLint rules:
   - forbid `@/integrations/supabase/client.server` outside `**/*.server.ts` and inside `**/*.functions.ts` module scope (allowed only inside handler bodies).
   - forbid `import ... from "@/lib/*.server"` in `src/routes/**` and `src/components/**`.
   - require `.inputValidator(` on any `createServerFn` that accepts input.
2. Add `scripts/check-serverfn-shape.ts` — walks `**/*.functions.ts`, fails if module scope has anything other than imports, type aliases, and exported `createServerFn` chains (prevents the `tss-serverfn-split` `ReferenceError` class).
3. Enable Supabase auth `password_hibp_enabled` and re-run the security scan.

### Phase 2 — Shared server primitives
1. `src/lib/_server/ownership.ts` — extract `assertPortfolioOwnership`, `logUnexpectedAccess`, `PortfolioAccessError` from `execution-slicer.server.ts`; migrate all call sites.
2. `src/lib/_server/with-owned-portfolio.ts` — a `createServerFn` builder helper: `.middleware([requireSupabaseAuth])` + auto-`assertPortfolioOwnership(context.userId, data.portfolioId)`.
3. `src/lib/_server/cron.ts` — `verifyCronRequest(request)` (constant-time compare of `CRON_SECRET`, IP/UA logging, rate-limit via existing `consume_rate_limit` RPC). Update all `src/routes/api/public/hooks/*` handlers.
4. `src/lib/_server/redact.ts` — `redactedError(e, { keep: ['status'] })` for third-party responses; adopt in Saxo, Yahoo, GDELT clients.

### Phase 3 — Break up mega-modules
1. Split `trading.functions.ts` (~2,800 lines / 34 fns) into thin re-exporters under `src/lib/trading/`:
   - `trading/backtest.functions.ts`, `trading/live.functions.ts`, `trading/sim.functions.ts`, `trading/config.functions.ts`, `trading/holdings.functions.ts`.
   - Keep the public API stable via `src/lib/trading.functions.ts` re-exports so imports don't churn.
2. Split `trading-engine.server.ts` into `engine/signals.ts`, `engine/sizing.ts`, `engine/router.ts`, `engine/orchestrator.ts`.
3. Split `routes/portfolio.$id.tsx` and `routes/index.tsx` into `src/features/portfolio/*` and `src/features/home/*` (containers + presentational components + hooks). Route file becomes a shell.
4. Split `news-reel.tsx`, `live-trading-card.tsx`, `backtest-run-history-card.tsx` along their internal `useMemo`/section boundaries.

### Phase 4 — Reduce service-role surface
Audit the 37 `supabaseAdmin` importers. For each call:
- If the query is on a row owned by `context.userId`, replace with `context.supabase` (RLS client). Delete the ownership check that's now redundant.
- If genuinely privileged, add a top-of-file comment `// service-role: <why>` and move admin import inside the handler.

Goal: ≤ 10 files touching `supabaseAdmin`, all `.server.ts`, all annotated.

### Phase 5 — Type + UI hygiene
1. Regenerate Supabase types; delete `as unknown as never` casts (write narrow `insertRow<'table'>()` wrapper if needed).
2. Route loaders that only prime React Query should `await ensureQueryData(...); return;` (shrinks route tree types).
3. Consolidate all UK formatting through `uk-time.ts` + `portfolio-performance-format.ts`. Add a lint rule flagging inline `new Intl.DateTimeFormat` / `NumberFormat` outside those two files.
4. Replace the `aegis:backtest-runs-updated` window event with `queryClient.invalidateQueries({ queryKey: backtestRunsQueryKey(portfolioId) })`.

### Phase 6 — CI + observability
1. Vitest projects split: `unit` (fast, on every commit), `integration` + `e2e` + `visual` (on push). Wire into `bun run test:unit` / `test:ci`.
2. Structured logger (`src/lib/_server/log.ts`) with levels + JSON output; replace ad-hoc `console.warn("SECURITY:...")` strings while keeping the greppable prefix.
3. Wrap Saxo/Yahoo/GDELT calls in circuit breaker (`circuit-breaker.server.ts` exists — extend and adopt uniformly).

## Rollout

Each phase is independently shippable and reversible. Suggested order matches priority: **Phase 1 → 2 → 4 → 3 → 5 → 6**. Phase 4 before 3 because reducing admin surface is the biggest security win and doesn't require touching mega-modules yet.

## What I need from you

1. Confirm you want me to proceed, and if so which phase(s) to start with — I'd recommend **Phase 1 + Phase 2** first (safety net + shared primitives) since they unblock everything else and change no behaviour.
2. Any modules you consider off-limits for restructuring (e.g. Saxo integration during live trading hours).
