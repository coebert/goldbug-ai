# Codebase review and optimisation plan

## Where the app stands

~186k lines across 1,026 files: 365 modules in `src/lib`, 24 routes, ~250 test files. The domain logic is genuinely well covered by tests and the valuation "kernel and gate" work paid off. The problems now are **size, duplication of patterns, and database cost** — not correctness of individual features.

Findings are ordered by payoff.

---

## 1. Database is the biggest real cost (do this first)

Measured from live query statistics:

| Symptom | Evidence | Fix |
| --- | --- | --- |
| `price_cache` read one symbol at a time | 98,088 calls, 75s total | Batch: one `IN (...)` query per run instead of a loop per symbol |
| `price_cache` upserts one row at a time | 8,950 calls, 84s total, 9.3ms each | Chunked bulk upsert (200–500 rows per statement) |
| `live_broker_log` scans | 321 calls averaging **228ms**, one query peaking at 2.3s | Index on `(portfolio_id, method, status, created_at desc)`; the existing index stops at `portfolio_id, created_at` |
| `live_broker_log` unbounded growth | 40MB / 29k rows, full-table `SELECT *` with no filter (79 calls, 280ms avg) | Retention job (keep 30 days), and never select `request`/`response` for list views |
| `decisions` reads pull `raw` | 3.6MB across only 190 rows; 818 calls at 84ms | Select explicit columns; move `raw` behind a detail-only fetch |

Also: two tables have RLS enabled with **no policy at all** (they are silently unreadable), and one extension sits in the `public` schema.

## 2. Break up the four files that carry too much

- `src/lib/trading-engine.server.ts` — 3,146 lines
- `src/routes/portfolio.$id.tsx` — 3,075 lines
- `src/lib/live-executor.server.ts` — 1,697 lines
- `src/lib/brokers/saxo.server.ts` — 1,335 lines

These are where regressions keep landing because every change touches shared mutable context. Split by phase, not by arbitrary line count:

```text
trading-engine.server.ts
  -> engine/context.ts        build inputs (prices, cash, holdings)
  -> engine/candidates.ts     universe + filters + blocklists
  -> engine/sizing.ts         buy caps, sleeves, risk envelope
  -> engine/exits.ts          stops, tail hedge, exit gates
  -> engine/orchestrate.ts    the tick, calling the above
```

`portfolio.$id.tsx` should keep only layout and route wiring; each card already exists as a component, so the extraction is mostly moving query definitions out.

## 3. Server-function split hazard (latent runtime crashes)

12 `*.functions.ts` modules declare `createServerFn` **and** module-scope helpers. The build's server-fn transform deletes those siblings, producing `ReferenceError` at runtime while typecheck passes — this class of bug has already bitten this app. Move helpers into matching `*.server.ts` files:

`algo-regime-backtest`, `algo-regime-scheduled-autotune`, `backfill-holdings-history`, `commodity-liquidity`, `corporate-actions`, `decision-summary`, `fx-health`, `fx-trade-drilldown`, `preflight-anomaly`, `price-scaling-audit`, `trade-errors`, plus the 746-line `live.functions.ts`.

## 4. Client data layer is ad hoc

162 inline `queryKey: [...]` literals and 35 independent `refetchInterval`s. Consequences: keys drift, cache invalidation misses, and several cards poll the same endpoint on different clocks.

- Introduce `src/lib/query-keys.ts` with typed key factories.
- Introduce shared `queryOptions` per resource so loader prefetch and component read cannot diverge.
- Consolidate polling into a few tiers (live: 15s, semi-live: 60s, static: on focus).

## 5. Type-safety and logging hygiene

- 54 `as any` casts and 18 `@ts-ignore` / `eslint-disable` in production paths — mostly around broker payloads. Replace with Zod schemas at the boundary (the pattern already exists in the app).
- 188 raw `console.*` calls. Route them through the existing `run-telemetry` logger so production output is structured and filterable.

---

## Suggested sequencing

**Phase 1 (highest value, low risk):** DB indexes, column projection, retention job, price-cache batching, and the two missing-policy tables.
**Phase 2:** move the 12 split-hazard helper sets; no behaviour change, removes a whole crash class.
**Phase 3:** query-key/`queryOptions` layer and polling tiers.
**Phase 4:** split `trading-engine.server.ts` and `portfolio.$id.tsx`, one module at a time, leaning on the existing test suite after each move.
**Phase 5:** Zod at broker boundaries, remove `as any`, structured logging.

Each phase is independently shippable and the existing tests gate every step.

---

## Technical notes

- New index: `create index on public.live_broker_log (portfolio_id, method, status, created_at desc)` — faster log reads, marginally slower inserts, a few MB extra.
- Retention should run via the existing `pg_cron` setup rather than an app-side sweep.
- No public API or route paths change anywhere in this plan.
