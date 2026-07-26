## Profit-Enhancement Rollout — 6 phases

I'll ship these in the order of highest profit-per-effort, verifying each phase with tests before moving to the next. Each phase is independently valuable, so you'll see improvements incrementally rather than after one giant drop.

### Phase 1 — Regime-based strategy on/off switching
Turn off strategies that historically lose money in the current regime instead of always running them all.
- Extend `src/lib/alpha/regime-matrix.ts` with an **enablement matrix**: which of {trend, mean-reversion, quality, carry, crypto sleeve} are active per regime (bull_quiet, bull_volatile, correction, bear, crisis, recovery).
- Gate strategy scores in `src/lib/alpha/composite.ts` — a disabled strategy contributes 0 weight, not just downweighted.
- Log the on/off state in `run_metrics` so we can attribute performance later.
- Surface active strategies in the regime panel UI.

### Phase 2 — Earnings & event-window awareness
Stop holding full size into binary events.
- New `src/lib/earnings-calendar.server.ts` fetching upcoming earnings (Yahoo/Finnhub free tier or Saxo instrument details).
- Extend `src/lib/risk-halts.server.ts` with an `EARNINGS_WINDOW` guard that trims positions to 50% of target size in the T-2 to T+1 window.
- Cache in a new `earnings_cache` table (14-day TTL).
- Show a "⚠ earnings in Nd" pill on `LiveHoldingsCard`.

### Phase 3 — ATR-based trailing stops
Replace fixed % stops with volatility-adaptive stops.
- Add `atrTrailingStop()` to `src/lib/market-data.server.ts` (14-day ATR × multiplier by risk level: 2.5 / 3.0 / 3.5).
- Wire into exit logic in `src/lib/trading-engine.server.ts` alongside existing exits (X1–X6).
- Persist per-position `trail_high` and `stop_price` on `holdings` for hysteresis.

### Phase 4 — VWAP/TWAP order slicing
Reduce execution slippage on orders > 25% of average daily volume.
- Extend `pending_slices` scheduler to time-slice large orders across 4–8 buckets over 30–120 min.
- Add spread-aware limit pricing for illiquid ETPs/ETCs (post at mid+edge instead of crossing).
- Wire post-trade TCA feedback: symbols with consistent >20bps slippage get position-size downweight in `alpha/composite.ts`.

### Phase 5 — Correlation-aware position sizing
Prevent correlated clusters from dominating risk.
- Reuse existing correlation matrix from `correlation-heatmap-card`.
- New `src/lib/risk/cluster-caps.server.ts`: build clusters at ρ > 0.7, cap combined cluster exposure by risk level (30/40/50%).
- Apply in sizing pass, after alpha ranking but before order emission.
- Add Kelly-fractional sizing (¼-Kelly) driven by existing `order-confidence` scores.

### Phase 6 — Tail hedge overlay (high-CAPE regimes only)
Cheap convex downside protection when valuations are stretched.
- New `src/lib/tail-hedge.server.ts`: when CAPE proxy > 30 AND regime ∈ {bull_volatile, correction}, allocate 0.5–1.5% of NAV to a defined put-spread proxy (via `PUTW`/`HDGE` ETFs Saxo supports) or long-vol ETP.
- Sleeve is capped and separate from primary allocation.
- Auto-unwind when regime turns risk-off (hedge has done its job) or CAPE reverts.

### Cross-cutting
- Every phase ships with unit tests in `src/lib/__tests__/`.
- Each phase adds one line to a new **Strategy Changelog** card on the admin route so you can see what changed and when.
- No changes to broker plumbing — this is all pre-trade signal & sizing work.

### Order & sequencing
I'll implement Phase 1 first, ship it, verify tests pass, then move to Phase 2, etc. Each phase is 1 turn of work.

Say **go** and I'll start with Phase 1.
