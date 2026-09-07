# Per-symbol cash flow table

## Build
- Add an authenticated account-history query that groups every completed fill by symbol.
- Convert each fill and its broker fee into the portfolio’s base currency before aggregation.
- Calculate gross cash used on buys, broker/estimated fees, net sale proceeds, and net cash still tied up per symbol.
- Mark whether each symbol is still held, and sort current holdings by the most cash consumed.

## Portfolio page
- Add a **Cash flow by holding** table directly below Holdings on real-money portfolios.
- Show symbol, buy cash, sell cash returned, fees, net cash used, and fill count.
- Clearly distinguish broker-billed fees from estimates, with compact mobile rows and full desktop columns.
- Refresh the table when broker fills update and on the existing safety interval.

## Validation
- Add calculation tests for buys, sells, partial fills, mixed fee sources, and sorting.
- Verify the real-money Portfolio page at desktop and mobile sizes.
