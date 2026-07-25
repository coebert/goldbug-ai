# Improving the AI's Currency-Trading Strategies

Today the AI receives a wallet snapshot, an exposure-by-currency map, a live FX matrix, and a short playbook (`src/lib/ai-fx-conversions.server.ts`). It can propose `fx_conversions` as a % of a wallet, applied in wallet-book mode. This is a solid foundation but is essentially **reactive pre-funding**. This plan turns it into an **intent-driven, signal-aware FX strategy** with proper risk controls, hedging, and a learning loop.

The plan is grouped into six phases. Each phase is independently shippable.

---

## Phase 1 — Give the AI a richer FX signal set

Right now the AI sees rates and balances but no market context. Add a lightweight FX signals block to the prompt.

- **Trend & momentum per pair**: 5/20/60-day % change, 20d realised volatility, distance from 50d SMA. Computed server-side from cached FX closes (extend `fx.server.ts` with a `getFxSeries(pair, days)` helper backed by the existing price cache; fall back to synthesising from cross-rates through USD).
- **Carry proxy**: static short-rate table per supported ccy (GBP, USD, EUR, CHF, JPY, CAD, AUD) refreshed weekly via an admin-editable `fx_carry_rates` table; expose annualised carry differential per pair.
- **Regime tag reuse**: reuse `regime-detector.server.ts` output (risk-on / risk-off / neutral) and map to FX bias (e.g. risk-off → favour USD/CHF/JPY, fade AUD/CAD).
- **Event calendar hook**: optional FOMC/BoE/ECB/BoJ dates as a static JSON in `src/lib/fx-events.ts` so the AI can flag "avoid conversions within 24h of event".

Deliverables: `src/lib/fx-signals.server.ts`, unit tests, and a new `fxSignals` section injected into `buildFxContext`.

## Phase 2 — Structured strategy intents, not just conversions

Extend the AI output schema from a flat `fx_conversions` array to a typed set of intents so the model reasons about *why*, not just *how much*.

```text
FxIntent =
  | { kind: "pre_fund",  target_ccy, cover_symbol, cover_notional, urgency }
  | { kind: "hedge",     ccy, hedge_pct, horizon_days, rationale }
  | { kind: "sweep_idle",from_ccy, min_balance_base, rationale }
  | { kind: "carry_tilt",long_ccy, short_ccy, size_pct_of_nav, max_hold_days }
  | { kind: "close_hedge",ccy, rationale }
```

Each intent is validated with Zod, then compiled into concrete `planFxConversion` / `planFxSpot` calls by a new `src/lib/fx-intent-compiler.server.ts`. This keeps the model's surface area small while letting us evolve execution safely.

## Phase 3 — Risk-aware sizing & guardrails

Prevent the AI from taking disproportionate FX bets.

- **Per-ccy exposure cap**: max non-base exposure as % of NAV, defaulting to risk-level presets (low 20%, medium 40%, high 60%). Enforce in the compiler; log `FX_INTENT_CAPPED` when trimmed.
- **Max daily FX turnover**: cap total converted notional per UTC day (e.g. 30% NAV) to stop pathological churn.
- **Min conversion size**: reject dust (<0.5% NAV) to avoid fee drag; already have fee model in `fx-convert-preview.functions.ts` — reuse it inside the compiler.
- **Carry-trade leash**: `max_hold_days` enforced by a nightly reviewer that emits a `close_hedge` intent when exceeded.
- **Circuit / matrix guard**: continue honouring `getFxCircuitState` and `fx-matrix-guard.ts`; intents that require blocked pairs are dropped with an audit row rather than silently ignored.

## Phase 4 — Hedging & carry playbooks in the prompt

Rewrite the playbook block in `ai-fx-conversions.server.ts` to give the model concrete decision rules instead of prose:

```text
PRE-FUND     : if planned foreign buy > wallet(target_ccy) → convert exactly the shortfall + 2% buffer.
HEDGE        : if non-base exposure(ccy) > cap AND 20d vol(pair) > threshold → hedge 50–100% back to base.
SWEEP IDLE   : if wallet(ccy) > 5% NAV AND no open/pending order in ccy for 3 days → sweep to base.
CARRY TILT   : only if regime = risk-on AND carry_diff > 2% AND 60d trend agrees; size ≤ 10% NAV.
STAND DOWN   : circuit open, matrix stale/identity, or event within 24h → no new intents; close_hedge allowed.
```

The prompt shows current values for each precondition so the model can cite them in `rationale`, which we already persist.

## Phase 5 — Learning loop (post-trade attribution)

Attribute P&L from FX intents so the model improves over time.

- Extend `wallet_snapshots` writes to also record intent id + kind at conversion time.
- Nightly job in `src/lib/fx-attribution.server.ts` computes realised P&L per closed intent (mark-to-market change in base ccy minus fees/spread).
- Feed a rolling summary (last 30 intents: hit rate, avg bps, worst outcome) back into the prompt via a new `fxPerformanceBlock` — same pattern used by `batch-lessons.server.ts` for equity trades.
- Surface in UI: extend `WalletHistoryCard` with an "FX intents" tab (kind, notional, rationale, realised P&L, status).

## Phase 6 — Observability & operator controls

- **FX Strategy card** on the portfolio page showing active intents, caps, remaining daily turnover, and a "pause FX strategy" toggle (`portfolios.fx_strategy_paused`).
- Extend `FxHealthCard` timeline with intent markers so we can see *why* conversions happened, not just that they did.
- Audit rows: `FX_INTENT_PROPOSED`, `FX_INTENT_COMPILED`, `FX_INTENT_CAPPED`, `FX_INTENT_EXECUTED`, `FX_INTENT_REJECTED` — all via `live_broker_log` for a single query surface.
- Tests: unit tests for signal computation and compiler; e2e tests that (a) an over-cap hedge intent is trimmed and logged, (b) a carry tilt is refused in risk-off regime, (c) pre-fund shortfall matches subsequent buy leg exactly.

---

## Technical notes

- **Files to add**: `src/lib/fx-signals.server.ts`, `src/lib/fx-intent-compiler.server.ts`, `src/lib/fx-events.ts`, `src/lib/fx-attribution.server.ts`, `src/components/fx-strategy-card.tsx`, tests under `src/lib/__tests__/`.
- **Files to edit**: `src/lib/ai-fx-conversions.server.ts` (schema + prompt), `src/lib/trading-engine.server.ts` (call compiler, persist intents), `src/lib/fx.server.ts` (`getFxSeries`), `src/components/wallet-history-card.tsx`, `src/components/fx-health-card.tsx`.
- **DB migrations**: `fx_carry_rates(ccy pk, annual_rate, updated_at)`; `fx_intents(id, portfolio_id, kind, payload jsonb, status, realised_pnl_base, created_at, closed_at)` with RLS + explicit GRANTs, plus a foreign key onto `portfolios`.
- **Prompt discipline**: keep the AI schema constraint-free (no Zod `.min/.max` inside `Output`) — enforce sizing/caps in the compiler, per AI SDK guidance.
- **Rollout**: Phase 1–2 behind a `portfolios.fx_strategy_v2` flag so we can A/B against the current playbook via existing `ab-testing.server.ts`.

## Rollout order (recommended)

1. Phase 1 (signals) + Phase 4 (playbook rewrite) — biggest quality lift, no schema changes.
2. Phase 2 (intents) + Phase 3 (guardrails) — structural refactor, one migration.
3. Phase 5 (attribution) + Phase 6 (UI) — feedback loop once real intent data exists.
