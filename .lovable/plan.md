# Per-currency wallet time-series chart

Add a chart on the portfolio Overview that plots each currency's wallet balance and the total base-currency cash over time, so you can see how the multi-currency wallet drifts across a sim run.

## What you'll see

A new card, "Wallet balances over time", on the portfolio Overview tab (next to Wallet & Affordability). Contents:

- Stacked-area chart (or line-per-currency toggle) with one series per currency present in the wallet (GBP, USD, EUR, ...), plus a separate line for `total base cash` (base-currency-equivalent of the whole wallet using each day's FX matrix).
- X-axis: date. Y-axis: amount in each currency's native units for the areas; the base-cash line is on a secondary axis in the portfolio currency.
- Tooltip shows every currency's balance for that day plus the base-cash total.
- Toggle between "native units per currency" and "each currency converted to base".
- Empty state: "No wallet history yet — snapshots start recording from the next tick."

## How it will work

Wallet history isn't recorded today. We will start capturing a daily snapshot going forward (reconstructing prior days from logs is unreliable once FX conversions and trades interleave).

1. **New table** `wallet_snapshots` (RLS + grants like our other portfolio-scoped tables):
   - `portfolio_id uuid`, `snapshot_date date`, `cash_by_ccy jsonb`, `base_ccy text`, `base_total numeric`, `created_at timestamptz`.
   - `UNIQUE (portfolio_id, snapshot_date)` for idempotent upserts.
2. **Write on every tick** — in `runDailyTick` (trading engine), right next to the existing `equity_snapshots` upsert, upsert a row with the post-tick `cash_by_ccy`, base currency, and base-total (using the FX matrix already fetched this tick).
3. **Server function** `getWalletHistory({ portfolioId, sinceDays? })` returns rows sorted by date, plus the list of currencies seen.
4. **Chart component** `WalletHistoryCard` in `src/components/wallet-history-card.tsx` using Recharts (same styling as the FX health / equity charts), lazy-loaded from `portfolio.$id.tsx` under Overview.

## Files

- Migration: new `wallet_snapshots` table + policies + grants.
- `src/lib/trading-engine.server.ts`: upsert snapshot alongside `equity_snapshots`.
- `src/lib/wallet-history.functions.ts`: new server fn.
- `src/components/wallet-history-card.tsx`: new chart card.
- `src/routes/portfolio.$id.tsx`: lazy-mount the new card on Overview.

## Notes

- No historical backfill — the chart begins populating from the next tick after this ships. This avoids fabricating balances from partial log evidence.
- If you'd rather I also attempt a best-effort reconstruction from `live_broker_log` FX events + `trades` and stitch it onto the front of the series, say so and I'll add it as an optional server-side reconstruction pass.
