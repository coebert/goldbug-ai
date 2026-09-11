# Core Performance page

## Goal
Add a signed-in **Core Performance** page for the configured 50% VWRL core, defaulting to three years of real stored price history and comparing it with the closest global equity ETF peers.

## What will be shown
- VWRL price history with selectable 1-year, 3-year, and 5-year periods; 3 years selected by default.
- Headline VWRL figures: total return, annualised return, volatility, maximum drawdown, latest price, and period high/low.
- A normalised return chart starting every fund at 0%, so VWRL and peers can be compared fairly despite different prices and currencies.
- Closest global peers: Vanguard FTSE All-World accumulating (VWCE), iShares Core MSCI World (IWDA), and Vanguard Total World (VT), using the listed symbols already supported by the app.
- A comparison table showing each fund’s return, annualised return, volatility, maximum drawdown, and difference versus VWRL.
- A 50% target view showing the current core weight, target weight, and how a 50%-sized VWRL allocation would have affected the account over the selected period compared with allocating that same 50% to each peer. The remaining 50% is held flat for a clear like-for-like allocation comparison.
- Clear unavailable-data states when a peer lacks sufficient stored history; unavailable peers will not distort rankings.

## Data and calculations
- Add one authenticated server function that loads the active real-money portfolio, current core settings/holding, and batched daily candles for VWRL plus the peer set.
- Normalise LSE prices and convert each fund’s history to GBP using date-appropriate FX where required before calculating returns.
- Align peers on common trading dates and calculate metrics in pure tested helpers.
- Use stored/cached market data only; opening the page will not call the decision AI or consume AI credits.

## App integration
- Add `/core-performance` with route-specific title and sharing metadata.
- Link it from navigation, the Markets page, and the existing Core Progress page.
- Reuse the app’s chart palette, cards, loading/error patterns, and responsive controls.

## Validation
- Unit-test return, annualisation, volatility, drawdown, date alignment, missing peer data, and 50% allocation calculations.
- Run focused tests and the TypeScript check.
- Verify signed-in desktop and mobile layouts with live account data, including chart legibility and no overlaps.
