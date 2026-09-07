# Per-holding equity change chart

## Build
- Add daily dates to the existing holding-history response so each price point has a real time axis while preserving the current purchase-cost baseline.
- Add a chart to the Portfolio positions page that rebases every current holding to 0% at purchase and plots its percentage change over time.
- Use distinct accessible colours and line patterns, a 0% reference line, readable dates, per-symbol tooltip values, and a clear empty state when history is unavailable.
- Keep the chart tied to the selected account and its existing one-minute refresh.

## Technical details
- Reuse the authenticated holding-history function and stored daily/intraday prices; do not create new database tables or change trading logic.
- Keep FX-leg valuation rules unchanged and omit holdings without a valid positive purchase cost from percentage calculations.
- Add focused tests for timeline alignment and percentage rebasing, then verify the page renders at desktop and mobile widths.
