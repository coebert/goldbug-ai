# Signals by Market

## Build
- Add a dedicated **Signals by Market** page linked from Markets and the app navigation.
- Group the configured trading universe by market, including US, UK, continental Europe, Japan, Australia, commodities, crypto funds, and FX context where available.
- Show each symbol's latest signal direction/strength, confidence, expected net edge, latest price time, and whether its market is currently open.
- Add market-level summaries for strongest opportunity, average confidence, average expected edge, and covered-versus-missing symbols.
- Make gaps explicit: distinguish no recent decision, missing learned strength, stale price, blocked instrument, and closed market.

## Behaviour
- Use the latest live portfolio and current stored decision/signal records; do not trigger AI calls or spend credits merely by opening the page.
- Keep owner-only reads behind the existing authenticated server-function boundary.
- Sort actionable positive signals first while preserving market grouping, with clear empty and error states.
- Refresh periodically and when live fills update so the view stays current.

## Interface
- Use the existing Aegis page shell, compact market summary cards, and a mobile-friendly signal table/list.
- Add filters for market and coverage status, plus links from each symbol to its existing detail page.
- Include page-specific title, description, and social metadata.

## Validation
- Add focused tests for market grouping, confidence/edge formatting, stale and missing coverage, and sorting.
- Verify the page on desktop and mobile with authenticated live data, including navigation and empty/error states.
