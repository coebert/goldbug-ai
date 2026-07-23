
# Trading Performance Upgrade — Full Rollout

This is a large body of work (6 categories, ~20 features). I'll ship it in 4 phases so each phase is testable on its own and the hourly cron keeps running throughout. Each phase ends with a wired-up UI surface so you can see it working.

## Phase 1 — Risk & execution safety (ship first, lowest regression risk)

- **Portfolio-level circuit breaker → sizing**: when trailing 5-day drawdown > 8%, halve all new position sizes for the next 5 sessions. Wires the existing `circuit-breaker.server.ts` into the sizing path.
- **Regime-triggered de-risking**: when regime flips to `crisis` or `bear`, target ≤40% gross exposure within 24h (trim overweights first, block new buys second).
- **Rebalance-band trimming**: winners > 1.5× target weight get auto-trimmed back to target on the hourly tick, independent of stops.
- **Limit orders with 15-min TTL** (replace market orders in the Saxo adapter path; paper engine mirrors the same fill logic).
- **TWAP slicing** for orders > 25% of ADV — split across 2-3 hourly ticks via a new `pending_slices` table.
- **Overnight-gap guard**: for US names, defer new buys placed within 30 min of close when IV rank > 70.

## Phase 2 — Signal quality (biggest edge)

- **Earnings/event blackout filter**: pull earnings calendar (Yahoo Finance) + FOMC/CPI dates; block or size-halve trades in 48h window. New `event_calendar` table refreshed daily.
- **Sector/factor rotation score**: rank 11 GICS sectors on blended 1M/3M relative strength; bias universe toward top-2, penalise bottom-2 in the AI prompt.
- **Correlation-aware caps**: compute rolling 60d pairwise correlations; reject a buy if it pushes portfolio avg pairwise correlation above 0.6.
- **Intraday microstructure signals** (deferred): 5-min bar features (VWAP distance, opening-range breakout, EoD momentum) added to the hourly feature vector.
- **Insider transactions & short interest** (SEC EDGAR + FINRA free feeds): weekly ingest into `alt_signals` table, exposed to prompt.

## Phase 3 — Learning loop upgrades

- **Per-signal decay tracking**: rolling 30/90/180d hit-rate per signal (RSI, SMA, sentiment, momentum, regime-alignment); down-weight decayed signals in the prompt.
- **Counterfactual replay**: for every blocked/skipped trade, log the 5/10/20-day forward return and feed into `portfolio_lessons`.
- **Regime-conditional lesson retrieval**: only inject lessons matching current regime.
- **Kelly-fraction sizing (cap 0.25)** layered over inverse-vol.

## Phase 4 — Infra & observability

- **Correlation & exposure panel** on portfolio detail page (heatmap + gross/net exposure gauges).
- **Signal-decay dashboard** on Admin (which signals are earning their keep).
- **Prompt A/B harness**: run variant B in shadow mode for a portfolio, log both decisions, weekly winner report.
- **Hourly-bar backfill** (5y) for the top-200 universe symbols to close the train/serve skew gap.

## Deferred / out of scope for this pass

- **Google Trends, Reddit/StockTwits, GitHub crypto signals** — need separate API keys or scraper infra; I'll ship the framework in Phase 2 (`alt_signals` table) so we can bolt them on without another migration.

## Technical details

- New tables: `event_calendar`, `alt_signals`, `signal_performance`, `pending_slices`, `prompt_variants` — all RLS-scoped to portfolio owner, with GRANTs to authenticated + service_role.
- New server modules: `event-calendar.server.ts`, `sector-rotation.server.ts`, `correlation.server.ts`, `signal-decay.server.ts`, `counterfactual.server.ts`, `kelly-sizing.server.ts`, `order-slicer.server.ts`, `ab-testing.server.ts`.
- Trading engine (`trading-engine.server.ts`) gets a new pre-decision pipeline: `[eventFilter → sectorBias → correlationCheck → circuitBreaker → regimeDeRisk → kellySize → volSize → guardrails]`.
- Live executor (`live-executor.server.ts`) switches market→limit with TTL cleanup on the next tick.
- Cron: hourly hook runs Phase 1+2+3 logic; a new daily 03:00 UTC hook runs earnings/insider ingest and signal-decay recompute.
- No breaking API changes; the Saxo kill-switch (`LIVE_SIM_PAPER_ONLY`) still gates production routing throughout.

## Rollout order

I'll implement Phase 1 → 4 in that order, in separate turns, so you can watch the hourly cron between phases and roll back any phase independently. Each phase is ~1-2 hours of implementation.

**Approve to start Phase 1, or tell me to reorder / drop items first.**
