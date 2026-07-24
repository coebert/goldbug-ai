# Consistent deposit-adjusted % across all equity/PnL charts

Today only the home-page `ModeSummaryTile` uses `computeModeSummary` to net out deposits. Several charts still compute `%` directly from raw equity totals, so a fresh deposit shows up as fake profit.

## Charts that need fixing

1. **`src/components/all-portfolios-chart.tsx`** — the "Real" and "Sim" equity lines. When rendered in "% vs start" mode (or any % tooltip), it currently normalises to the first snapshot; a mid-period deposit spikes the curve.
2. **`src/routes/portfolio.$id.tsx`** — the per-portfolio chart's `compareMode === "pct"` branch. Line 911 computes `(value/startingCash − 1) × 100`, ignoring any `addSimFunds` deposits after start.
3. **`src/routes/compare.tsx`** (line ~153) — the multi-portfolio comparison normalises each series with `(total_value − starting_cash) / starting_cash`, again ignoring deposits.
4. **Home tiles / sparkline hovers** already use `computeModeSummary`; verify no stray raw-% remains after the refactor.

Backtest metrics on `portfolio.$id.report.tsx` (strategy_return_pct, alpha, drawdown, etc.) are **out of scope** — those come from historical simulation with no deposit concept.

## Approach

### 1. Extract a shared helper — `src/lib/deposit-adjusted-series.ts`
```ts
// Given an equity series for ONE portfolio + its deposits, return a
// deposit-adjusted series where each point is:
//   adjusted[i] = raw[i] − cumulativeDeposits(<= date[i], strictly after start)
// and % vs start uses adjusted values only.
export function buildDepositAdjustedSeries(
  points: { date: string; equity: number }[],
  deposits: { date: string; amount: number }[],
  startDate: string,
): { date: string; equity: number; adjusted: number; pct: number }[]
```
Same window semantics as `computeModeSummary` (`amount` on `startDate` is treated as already baked into the baseline; only deposits with `date > startDate` are subtracted). This keeps every chart consistent with the tile.

### 2. Route the helper through each chart
- **`all-portfolios-chart.tsx`**: sum deposits per mode per date, feed into the helper, plot `adjusted` instead of raw when the user is viewing % (and keep raw for £-mode).
- **`portfolio.$id.tsx`**: fetch per-portfolio `funding_events` (already stored for sim funding), pass through the helper. In `pct` mode plot the helper's `pct`; in raw mode plot equity but ensure tooltips display the deposit-adjusted `pct` badge.
- **`compare.tsx`**: same treatment per compared portfolio, so a portfolio that received deposits mid-comparison doesn't visually beat the others.

### 3. Data plumbing
- `all-portfolios-equity.ts` already returns deposits alongside snapshots — pass them through.
- `portfolio.$id.tsx` loader: extend the server function that returns equity history to also return `funding_events` (date + amount) so the client can adjust without a second round-trip.
- `compare.tsx`: extend the compare server function similarly (currently returns snapshots only).

### 4. UI touches
- Add an "adjusted for deposits" tooltip hint on any % axis so it's obvious that curves diverge from raw £ growth by design.
- Real-money charts (which never receive deposits from within the app — deposits come from Saxo cash sync) still need the same code path; when the deposit list is empty the helper is a pass-through, so this is free.

### 5. Tests
- Unit: `buildDepositAdjustedSeries` — empty deposits (pass-through), single deposit mid-series, deposit on start date (ignored), withdrawal, multiple deposits, unknown dates.
- Visual regression: refresh snapshots for `AllPortfoliosChart` and the portfolio detail chart with a fixture that includes a mid-period deposit — the % curve must stay flat when the deposit exactly funds the equity bump.
- Integration: extend `real-money-equity-extreme-flow.integration.test.tsx` style — feed the full pipeline with a deposit and assert both tile pct and chart pct agree to within tolerance.

## Out of scope
- Backtest/report metrics (`strategy_return_pct`, `alpha_pct`, drawdown) — no deposits in the simulator.
- Per-asset "since purchase" sparklines (already share-based, unaffected).
- Any change to how deposits themselves are recorded.

## Risk
- Extending the compare + portfolio loaders may bump the server-function response shape; existing callers must remain compatible. I'll keep the new field optional.
- Snapshot tests will need re-baselining after the switch; that's expected and part of the plan.
