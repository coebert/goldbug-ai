# Plan: Full AI trading upgrade

This is a large upgrade — grouped into 6 phases so we can ship and verify incrementally. Each phase is self-contained; you can stop after any phase.

## Phase 1 — Signal quality
- Add MACD, Bollinger Band width, ATR, volume-weighted momentum, and DXY/VIX cross-asset context to the feature builder in `src/lib/trading-engine.server.ts`.
- Add weekly-timeframe SMA/RSI alongside daily; require alignment for high-conviction entries.
- Add a sector-relative-strength score using ETF proxies (XLK, XLF, XLE, etc.) cached via `price_cache`.
- Extend `signal_weights` schema and the `SignalImportance` UI to render the new features.

## Phase 2 — News & sentiment
- Replace keyword matching with an LLM sentiment pass (Gemini Flash Lite) that scores each headline `-1..+1` with extracted tickers/entities. Cache in `news_cache` (new columns `sentiment`, `entities`, `source_weight`).
- Weight by source (Reuters/Bloomberg/FT > aggregators) and apply exponential recency decay (24h half-life).
- Add an events calendar table (`market_events`) for CPI/FOMC/earnings; force position-size reduction into event windows.

## Phase 3 — Decision process
- Conviction-weighted sizing: `size = min(kelly_fraction * edge * conviction, max_position)` with a Kelly cap of 0.25.
- Portfolio-level optimizer pass after per-asset decisions: reject/scale trades that push aggregate correlated exposure over a cap (uses 60d return correlations).
- Loss cooldown: track last stop-out per symbol; halve size for 5 trading days after.

## Phase 4 — Learning loop
- P&L attribution by dominant signal per trade; store in new `signal_attribution` table.
- The learning layer down-weights losing signal sources per-regime when writing `portfolio_lessons`.
- Counterfactual logging: for each decision, run the engine at Conservative/Balanced/Aggressive risk configs and log what would have been done (`decision_counterfactuals` table).
- Monthly walk-forward re-calibration cron: refits signal weight priors on trailing 12 months of realized P&L.

## Phase 5 — Execution realism
- Add limit-order support with a bid/ask spread model (proxy: 5–20 bps by asset class) to backtest and long-horizon simulators.
- Partial fills capped at 1% of average daily volume; overflow queued to next bar.

## Phase 6 — Guardrails
- Circuit breaker: auto-pause portfolio and require review when diagnostics detect >20pp weight drift or 5 consecutive losses. Surface a banner in the portfolio view.
- Regime-linked risk config: when `regime-detector.server.ts` flips to `bear` or `crisis`, apply a tightened overlay (max_position × 0.5, stop-loss tightened by 30%) until it clears.

## Technical scope
- Schema: `market_events`, `signal_attribution`, `decision_counterfactuals`, new columns on `news_cache`, new column `circuit_breaker_state` on `portfolios`.
- New files: `src/lib/signals/technical.server.ts`, `src/lib/signals/cross-asset.server.ts`, `src/lib/sentiment.server.ts`, `src/lib/portfolio-optimizer.server.ts`, `src/lib/execution-model.server.ts`, `src/lib/attribution.server.ts`, `src/lib/walk-forward.server.ts`, `src/components/circuit-breaker-banner.tsx`.
- Cron: new monthly `aegis-recalibrate` job.
- All model calls stay on `google/gemini-3.6-flash` except the sentiment pass which uses `google/gemini-3.1-flash-lite` for cost.

## Rollout order
Ship Phase 1 → 2 → 3 in one build (they compose into the decision loop). Then Phase 4 → 5 → 6 in a follow-up build so each has room to be validated in paper trading before the next layer stacks on.

Reply "go" to start with Phases 1–3, or tell me which phase(s) to prioritize.
