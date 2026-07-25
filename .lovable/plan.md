# Trading Strategy Review & Hardening Plan

## Where you are today (strengths)
The engine is already unusually sophisticated for a single-user app:
- **Signals:** MA/MACD/RSI/Bollinger/ATR, weekly multi-timeframe, volume-weighted momentum, cross-asset (SPY/VIX/GLD/TLT), options snapshot, cross-sectional ranking, news + sentiment momentum.
- **Sizing/guardrails:** conviction-weighted Kelly cap, calibration multiplier, ensemble second-opinion, loss cooldowns, sector rotation multiplier, portfolio drawdown throttle, gross-exposure by regime, correlated-cluster cap, ATR trailing stop, stop-loss / take-profit / max-hold auto-exit, per-symbol / per-class / commodity-group caps, overnight-gap guard, FX matrix guard, commodity liquidity gates.
- **Learning:** hyperparameter tuning + walk-forward, calibration snapshots, counterfactuals, per-signal decay tracking, portfolio lessons, shadow variant B.
- **Playbooks:** historical, hedge-fund, commodity, FX — all injected into the system prompt.

## The core weaknesses to fix
1. **Edge is diffuse.** Many signals feed a single LLM that decides everything. LLM output variance can dilute otherwise-good edges, and the five signal-weight buckets are the AI's *self-attribution*, not a measured edge.
2. **Sizing is defensive-only.** Every multiplier can *shrink* a trade; almost none can *grow* a high-quality one. That structurally caps returns even when the setup is A+.
3. **Exits are single-layer.** Stop-loss / take-profit / ATR trail are fixed % — no scale-out ladder, no chandelier trail, no time-stop tied to thesis half-life, no re-entry rule after a stop.
4. **No explicit alpha model with an out-of-sample track record.** Signal-decay is tracked but not *acted on* — decayed signals still weigh the same in the prompt.
5. **Regime → strategy mapping is soft.** The AI is *told* the regime; strategy switching (e.g. trend-follow vs. mean-revert vs. carry) is not enforced structurally.
6. **Correlation & concentration.** 35% correlated-cluster cap is a hard number, not risk-parity based. No factor-tilt tracking (value/momo/quality/low-vol/carry) despite the playbook citing them.
7. **FX & commodities** have playbooks but no dedicated systematic overlays (carry, trend, curve, real-yield-vs-gold beta).
8. **No execution alpha.** All orders go as market with a simple ATR-vol slippage assumption; no VWAP/POV/passive posting, no time-of-day model, no earnings/event blackout override for exits.

## The plan (6 phases, shippable independently)

### Phase 1 — Turn the LLM into an orchestrator, not the sole alpha
Split decisions into **systematic candidates + LLM adjudication**:
- Build `src/lib/alpha/` with four independent, testable models producing a score in [-1..+1] and a horizon (days) per symbol:
  1. `trend.ts` — 12-1 momentum, 50/200 MA state, ADX-lite from ATR%.
  2. `mean-reversion.ts` — z-score of price vs. 20d, RSI extremes, Bollinger %b — only fires inside 200d uptrend and low-vol regime.
  3. `quality-value.ts` — proxy factors we can compute cheaply (drawdown-adjusted momentum, low realised vol, positive earnings drift via news sentiment slope).
  4. `carry.ts` (FX + commodities) — real-yield diff proxy, gold-vs-real-yield beta, oil term structure heuristic.
- **Ensemble score** = weight-blend by *live signal-decay hit-rate* (already tracked). Decayed signals lose weight automatically.
- LLM receives ranked candidates with scores and only decides: pass, size up, size down, or hold; it must cite the model that fired.

### Phase 2 — Two-sided sizing (grow winners, not just shrink losers)
Currently every multiplier is ≤1. Introduce bounded up-multipliers:
- **Conviction concurrence bonus:** if ≥3 of {trend, mean-rev, quality, cross-sectional top-decile, positive news momentum} agree → ×1.25 (capped by per-symbol cap).
- **Regime tailwind bonus:** if regime playbook explicitly favours the asset class → ×1.15.
- **Pyramid rule:** allow adding to an *existing winner* up to 1.5× original size when price makes new 20d high AND trailing stop has been raised twice.
- Absolute ceiling stays the per-symbol cap; multipliers are stacked *inside* it.

### Phase 3 — Multi-layer exits
Replace the single stop / TP with a ladder:
- **Initial stop:** max(ATR×N, structural swing low).
- **Chandelier trail:** highest close × (1 − k·ATR); k tightens as unrealised gain grows.
- **Scale-out ladder:** sell 25% at 1R, 25% at 2R, let 50% run on trail.
- **Time-stop tied to horizon:** if the alpha model's horizon expires with <0.5R progress, exit.
- **Re-entry rule:** after a stop, block the symbol for `max(cooldown, 5×ATR days)` — you already have cooldowns; just wire ATR days in.
- **Event blackout override:** force flat or hedged into earnings/FOMC if position is >5% of NAV.

### Phase 4 — Real regime-conditional strategy switching
Enforce (not just suggest) via the orchestrator:
- **Risk-on / expansion:** trend + quality dominate; mean-rev muted; commodities cyclical.
- **Late cycle / stagflation:** trend + carry; gold overweight; trim high-beta growth.
- **Recession / risk-off:** de-risk cyclicals to zero, keep quality + gold + duration proxy (TLT), block new momentum buys.
- **Deflation:** cash + quality only.
- **Rising-rate shock:** kill duration; gold only if real yields *falling*.
Implemented as a matrix `regime × strategy → weight` in `src/lib/regime-strategy-matrix.ts` that scales each alpha model's contribution before the ensemble.

### Phase 5 — Portfolio construction on risk, not dollars
- Add **volatility-weighted target position sizes** (already have `volatility_sizing` flag; make it default on).
- Add **factor-exposure tracker** (momentum / value / quality / low-vol / carry) computed from current holdings; cap any single factor at 40% of gross risk.
- Replace the 35% correlated-cluster $ cap with a **risk-parity cluster cap**: cluster gross vol ≤ 30% of portfolio target vol.
- **Portfolio target vol:** each risk level maps to an annualised vol target (Conservative 6%, Balanced 10%, Aggressive 15%); scale total gross exposure to hit it.

### Phase 6 — Execution alpha & measurement
- **Order slicing:** for orders >0.5% of ADV, slice into 3–5 clips over the session.
- **Time-of-day filter:** avoid the first & last 15 min unless exiting a stop; measured slippage is worst there.
- **Post-trade attribution v2:** per-model P&L (not just per-signal). Feed back into the alpha-model weights (Phase 1) so bad models atrophy automatically.
- **A/B live-shadow:** the existing "shadow variant B" becomes the new orchestrator — promote to primary only after 30 sessions of statistically better risk-adjusted return.

## Technical section (for reference)

New files:
- `src/lib/alpha/{trend,mean-reversion,quality-value,carry}.ts` — pure scorers, unit-tested.
- `src/lib/alpha/orchestrator.server.ts` — combines scorers with signal-decay weights and regime-strategy matrix; produces `RankedCandidate[]`.
- `src/lib/regime-strategy-matrix.ts` — the enforceable weights table.
- `src/lib/exits/{chandelier,scale-out,time-stop,event-blackout}.ts` — layered exit logic.
- `src/lib/sizing/pyramid.ts` and `src/lib/sizing/concurrence-bonus.ts`.
- `src/lib/portfolio/factor-exposure.ts` and `src/lib/portfolio/vol-target.ts`.
- `src/lib/execution/slicer.ts` and `src/lib/execution/tod-filter.ts`.

Wiring points in `trading-engine.server.ts`:
- Replace the current single-LLM decision path with: build `RankedCandidate[]` → LLM adjudicates → sizing pipeline (existing shrinks + new bonuses) → exit-ladder attached at order creation → factor/vol caps applied at portfolio level.
- Keep every existing guardrail; they layer under the new logic.

Tests to add:
- Unit tests per alpha model with fixture candles.
- Property tests: sizing pipeline never exceeds per-symbol cap even with all bonuses stacked.
- E2E: regime transition flips strategy weights within one tick; scale-out ladder produces 3 sells at 1R/2R/trail.

## Suggested rollout order
1. Phase 3 (multi-layer exits) — biggest immediate risk win, isolated code.
2. Phase 1 + 4 (alpha orchestrator + regime matrix) — biggest return win.
3. Phase 5 (vol-target + factor caps) — makes returns *reliable*.
4. Phase 2 (two-sided sizing) — unlocks upside once 1–4 are stable.
5. Phase 6 (execution + measurement) — polish and self-improvement loop.

Approve and I'll start with Phase 3 (exits) as the first shippable slice.
