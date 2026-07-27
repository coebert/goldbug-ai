# Strategy: Defending Against AI-Driven Market Patterns

Modern markets show new footprints from algorithmic/AI participants: flash crashes, liquidity mirages, momentum ignition, quote stuffing, correlated de-risking (all algos exit together), and sudden volatility bursts around events. This plan hardens the app end-to-end.

## Goals

1. Detect abnormal microstructure conditions (liquidity vacuums, vol bursts, correlated de-risking) in real time.
2. Adapt execution to avoid getting picked off by faster algos.
3. Size and hedge for fatter tails and faster regime shifts.
4. Give the AI decision layer explicit priors about algo-driven behavior.

## Phases

### Phase A — Detect: Algo-driven regime & microstructure signals
New module `src/lib/microstructure/algo-regime.ts`:
- **Volatility burst detector**: short-window realized vol vs 20d baseline; flag when ratio > 2.5.
- **Liquidity vacuum detector**: recent volume / rolling median < 0.4 with widening spread proxy.
- **Momentum-ignition / mean-reversion whiplash**: count sign flips of 5-bar returns in last 30 bars vs historical.
- **Correlated de-risking**: cross-sectional correlation of top holdings' 5-day returns spiking above baseline (all-algos-exit signature).
- **Gap-and-fade**: overnight gap > 1.5×ATR that reverses ≥50% within first 30 min.

Outputs an `AlgoRegimeSnapshot { volBurst, liquidityVacuum, whipsaw, correlationSpike, gapFade, score, tier: normal|elevated|extreme }`.

### Phase B — Adapt execution
Extend `src/lib/broker-simulator.ts` and live executor:
- **Adaptive participation cap**: shrink `maxParticipationRate` (e.g. 15% → 5%) when tier=elevated, 2% when extreme.
- **Wider TWAP slicing** in elevated regimes; skip new entries entirely in `extreme`.
- **Anti-momentum-ignition guard**: reject market orders when short-window vol > 2× baseline; require marketable-limit with max slippage cap.
- **Post-only / passive bias** when spread proxy is wide.
- **Cool-down after whipsaw**: block re-entry into a symbol for N minutes after a stop-out during whipsaw regime.

### Phase C — Size & hedge for fatter tails
- **Vol-targeted sizing**: scale position by `targetVol / max(realizedVol, 1e-6)`; new helper `src/lib/sizing/vol-target.ts`.
- **Correlation-spike downscale**: when Phase A correlation signal fires, apply extra 0.5× multiplier via existing `sizeAgainstClusterCap`.
- **Tail-hedge boost**: when `tier=extreme`, bump `TailHedgeConfig.baselinePctNav` (still capped) — integrate into `computeTailHedge` via a new `algoRegimeTier` input.
- **Circuit breaker**: pause new buys when portfolio's realized 1-day move > 3σ vs 60d baseline; require next-tick confirmation.

### Phase D — Inform the AI decision layer
- Append an `ALGO-DRIVEN MARKET REGIME` block to `HISTORICAL_PLAYBOOK` in `src/lib/historical-playbook.server.ts` (flash-crash 2010, vol-mageddon Feb-2018, Mar-2020 gamma, meme-squeeze 2021, Aug-2024 yen-carry unwind) plus base rates and behavioral rules ("do not chase 1-min breakouts", "widen stops in whipsaw", "prefer VWAP over market").
- Pipe the current `AlgoRegimeSnapshot` into the decision prompt and heuristic fallback (`src/lib/heuristic-decision.ts`) so both branches see the tier.

### Phase E — Observability
- New card `src/components/algo-regime-card.tsx` on the portfolio page showing current tier, active signals, and the sizing/execution multipliers currently applied.
- Log every tier transition to `ai_decision_audit` context so post-hoc review can confirm the guardrails fired.

### Phase F — Tests
- Unit tests for each detector (`microstructure/__tests__/*.test.ts`) with synthetic bar fixtures.
- Integration test: extreme-tier tick should produce zero new market buys and reduced participation.
- Property test: vol-target sizer never exceeds risk-level cap and monotonically shrinks as realized vol rises.
- Regression: existing scenario-report matrix still passes; add a new "algo-driven volatile" preset to `SCENARIO_MATRIX`.

## Non-goals

- No new venue/broker integration; execution changes stay within existing Saxo pathway and the simulator.
- No change to the equity/cash accounting layer.
- No new user-visible risk-level presets (existing conservative/balanced/high still apply).

## Rollout

1. Land Phases A, C, F behind pure functions (no live wiring) — verifiable via tests.
2. Wire Phase D (playbook + heuristic) — decision-only impact.
3. Wire Phase B into simulator, then live executor behind a per-portfolio flag `algo_regime_guard_enabled` defaulting on.
4. Ship Phase E card once signals stabilize.
