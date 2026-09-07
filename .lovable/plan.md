# Cash and reserve history chart

## What will be added
- Add a **Cash & reserves** chart to the real-money portfolio view, alongside the existing account history.
- Plot the account’s actual end-of-day cash balance from its daily snapshots.
- Overlay the AI’s money-based reserve rules for each day:
  - the minimum viable buy size;
  - the rolling 30-day dealing-cost allowance;
  - the allowance still available after actual/modelled fill costs.
- Show the high-edge reserve ticket count, daily buy limit, and cooldown rule in the chart summary/tooltip so ticket-based rules are not misleadingly drawn as currency.
- Include 30D, 90D, 1Y, and All ranges, clear tooltips, a legend, loading/error/empty states, and mobile-safe axes.

## Data and calculations
- Add an authenticated account-history reader scoped to the selected portfolio.
- Read daily `cash` and `total_value` from the existing account snapshots, then calculate the NAV-scaled governor settings for each date using the same live rule functions as order routing.
- Build each day’s trailing 30-day friction from the account’s fills, preferring broker-invoiced charges and falling back to the existing cost model where necessary.
- Do not invent missing cash history: omit days without an authoritative cash snapshot and explain gaps in the empty-state copy.

## Placement and verification
- Show the chart only for the real-money account on its main portfolio page and Portfolio Summary page, using one shared component.
- Add focused calculation tests for changing NAV, rolling-window expiry, invoice/model fallback, and sparse snapshots.
- Verify the live account’s available history renders clearly on desktop and phone without changing any trading rules.
