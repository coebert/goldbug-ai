# Global Coverage Page

## What will be built
- Add a signed-in **Global coverage** page covering the configured US, UK, European, Japanese, Australian, crypto, commodity, and currency groups.
- Show each group’s suggestion count, full/partial/no-fill counts, quantity-weighted fill rate, average confidence, and expected edge.
- List missed signals with the suggested size, confidence, expected profit, outcome since suggestion, and the known reason it did not fill.
- Add 30/60/90-day period controls and filters for market and missed-signal reason.
- Link the page from Markets and the shared navigation.

## Data and matching
- Read stored next-best-trade suggestions, live orders, live fills, latest prices, and broker blocks for the selected real portfolio; opening the page will not call the AI or consume credits.
- Match broker-native and market symbols with the existing symbol-key normalisation.
- Credit each fill to at most one suggestion within the existing three-day matching window, preserving partial fills.
- Treat a signal as missed only after its matching window closes; keep recent pending opportunities separate from genuine misses.
- Group by the same venue-to-market mapping used on Signals by Market.

## Validation
- Add focused tests for full, partial, missed, pending, and duplicate-suggestion matching across markets.
- Verify calculations, navigation, filters, and mobile/desktop presentation against signed-in account data.
