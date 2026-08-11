# Trader's review: where the edge is, where the money leaks

## 1. What the live record actually says

Real-money account (25 Jul – 11 Aug 2026):

- NAV £10,189 -> £10,093, peak £10,273. Flat-to-slightly-down.
- 40 fills, £21.4k of notional on a £10.2k account = ~2.1x turnover in 11 trading days.
- Average ticket £534, but the tail is ugly: VMID.L bought 5 times for £521 total (~£104 a ticket, one as small as £36), MKS.L accumulated across 9 separate buys.
- Median holding period roughly 5–9 days.
- `live_fills.fee` is 0.00 on every single fill. The app has never seen a real cost number.

Read as a trading book: the strategy is roughly break-even gross and loses net. The problem is not the signals being wrong, it is that the book pays a fixed commission floor plus stamp duty 40 times to express maybe 8 real ideas, and it cannot even measure what that costs because the fee field is empty.

The two sim books tell the opposite story only because they trade six-figure tickets where fixed costs vanish. Do not read their P&L as validation of the strategy.

## 2. Strategy strength: honest scorecard

**Genuinely strong**
- Cost/impact modelling (`saxo-fees.ts`, `spread-slippage.ts`) — proper commission floors and sqrt-impact, not a flat bps fudge.
- Exit architecture (ATR trailing, chandelier, scale-out at 1R/2R, time stop) is institutional-grade.
- Risk halts are flow-adjusted and valuation-suspect-aware, and never block sells. Correct design.
- Continuous SMA conviction ramps and the unified-score de-duplication of alpha/cross-sectional/ensemble.
- Extensive execution Monte-Carlo, calibration and OOS work — which has already told you the honest answer: coupling assumptions are second-order, friction is first-order.

**Structurally weak**
- Static alpha weights with no live feedback. The regime weight matrix and enablement table are narrative priors, never walk-forward validated. Worse, the signal-decay tracker still measures a legacy taxonomy (`sma_trend, rsi, price_change...`) that no longer matches the live scorers, so no decay is ever detected.
- Correlated signals double-counted. Trend and breakout are the same factor; mean-reversion and carry both lean low-vol. Fixed weights over-load momentum.
- Multiplicative size stacking with no combined ceiling (breakout x1.2, conviction x1.5, sector, regime...).
- Two competing vol-sizing paths, neither covariance-aware. There is no portfolio vol budget, only per-name vol.
- No event/earnings gating in the entry path. The book will buy a breakout into a print.
- No sector/correlation concentration cap — only a flat "5 concurrent signals".
- All orders are market orders. The slippage model is used to *describe* cost, never to *avoid* it.
- Stops live in the engine, not at the broker. Between hourly ticks the book is unprotected.
- The cost governor sits inside a swallow-all `try/catch` marked "advisory", ranks buys by raw notional rather than conviction, and its 5-day cooldown silently contradicts swing style's 2-day re-entry.
- Carry is a volatility heuristic, not real carry, in a book that runs a crypto sleeve where funding rate is a genuine edge.

## 3. Plan

Ordered by expected pounds per unit of work, on the smallest real account.

### Phase 1 — Stop the leak (biggest, most certain P&L impact)

1. **Capture real costs.** Populate `live_fills.fee` from Saxo (order/fill cost endpoint or the account activity feed) plus a stamp-duty and FX-markup line. Add a nightly reconciliation of modelled vs realised cost, surfaced on the dashboard as bps of NAV. Nothing else in this plan can be validated until this exists.
2. **Intent-level ticket aggregation.** Before routing, net all same-symbol same-side orders for the tick into one ticket, and carry unfilled intent forward instead of re-slicing it the next hour. This alone removes the MKS.L-9-buys pattern.
3. **Make the governor mandatory, not advisory.** Fail closed on buys if `loadGovernorInputs` throws; log a hard block. Also enforce the min-ticket floor at *order construction* so a £36 VMID.L order is never built.
4. **Rank governor admissions by expected edge per pound of friction** (`unifiedScore x expected move / estCost`), with notional only as tie-break. Today the biggest ticket wins, not the best idea.
5. **Reconcile churn parameters with trading style.** One resolver returns the binding cooldown/min-hold, logs which rule bound and why. Remove the silent override.
6. **Concentration budget.** Cap gross exposure per sector and per correlation cluster (reuse the fitted cluster structure already in `execution-correlation-*`), not just per name.

Expected effect: on the live book, friction was ~1.8% of NAV per fortnight. Cutting turnover by ~60% while keeping the same ideas is worth roughly 3–4% of NAV a year on its own.

### Phase 2 — Execute better on the trades that survive

7. **Limit orders for anything above a participation threshold.** Thread the existing `OrderUrgency` / participation output into `BrokerOrderRequest`: passive-at-mid-plus-half-spread with a timed cross-to-market fallback. The evidence from the limit-order study says passive resting is net-negative on daily bars — so use marketable limits (price protection, not queue positioning) rather than true passive.
8. **Broker-side protective stops.** Place resting stop orders at Saxo on entry, and reconcile them each tick against the engine's ATR stop level. Closes the between-tick gap.
9. **Wire or delete `maxNotionalForImpactCap`.** It currently protects nothing.
10. **Smooth the NAV-band step functions** in `governorForNav` into continuous interpolation.

### Phase 3 — Make the alpha adaptive instead of static

11. **Repoint signal-decay tracking at the live taxonomy** (`trend / mean_reversion / quality / carry / breakout`, plus `alpha / crossSectional / ensemble`) and feed realised hit-rate and edge into a bounded weight multiplier (say 0.5x–1.5x on the regime prior, updated weekly). This is the single highest-value alpha change: it turns a frozen model into a learning one.
12. **Event gating.** Veto or haircut new entries within N days of scheduled earnings using `earnings_cache`; allow exits always.
13. **Orthogonalise correlated scorers.** Regress breakout on trend and mean-reversion on carry, blend the residuals, or apply a combined-factor exposure cap.
14. **One vol-sizing path, covariance-aware.** Merge `sizing/vol-target.ts` and `riskParityTargetSpend` into a single portfolio vol-budget allocator that uses the calibrated correlation matrix already fitted.
15. **Single combined multiplier ceiling** across breakout, conviction, sector and regime multipliers, with an audit line naming which factor bound.
16. **Real carry.** Funding rate and basis for the crypto sleeve, forward dividend yield for equities, replacing the vol proxy.
17. **Walk-forward the regime matrix.** Use the existing harness to validate (or refute) the hand-set weights and the enablement on/off table, then persist fitted weights with the calibration-snapshot mechanism.

### Phase 4 — Prove it

18. Run the existing walk-forward + friction-ladder harness with the **realised** fee data from Phase 1 substituted for the modelled costs, both pre- and post-changes, and publish a before/after cost-and-return attribution card on the dashboard.
19. Add a hard KPI to the dashboard: **realised friction as % of NAV, trailing 30d**, with the 40bps budget line drawn on it. That is the number that decides whether this account makes money.

## Technical notes

- Touch points: `src/lib/live-executor.server.ts` (aggregation, governor fail-closed, limit routing), `src/lib/cost-governor.ts` / `.server.ts` (ranking, interpolation), `src/lib/brokers/saxo.server.ts` (fee capture, resting stops, limit orders), `src/lib/signal-decay.server.ts` + `src/lib/alpha/regime-matrix.ts` (adaptive weights), `src/lib/alpha/composite.ts` (orthogonalisation, event veto), `src/lib/alpha/sizing.ts` + `src/lib/sizing/vol-target.ts` (merge).
- New tables likely needed: none for Phase 1 beyond populating `live_fills.fee`; a small `signal_weight_history` for Phase 3 item 11.
- Every change lands with unit tests plus a replay of the 25 Jul – 11 Aug fill tape to show what would *not* have been traded.

## Suggested first slice

Phase 1 items 1–4. They are self-contained, measurable within a fortnight, and address the only loss driver the live data actually supports.
