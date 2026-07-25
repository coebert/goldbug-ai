## Goal

Make the app currency-aware end-to-end so it can:

1. Trade spot FX pairs as instruments (EURUSD, GBPUSD, USDJPY, …) through Saxo.
2. Run portfolios denominated in USD/EUR/JPY (not just GBP) with equity, cash, and P&L in that currency.
3. Place non-native equity trades reliably (e.g. buy US stocks from a GBP portfolio) with real FX sizing.
4. Offer a manual "Convert cash" tool inside each portfolio.

## Phased delivery

Four scoped phases, each independently valuable and shippable. Each phase ends with tests + a UI surface so nothing hides in the backend.

### Phase A — Currency foundations (no user-visible behaviour change yet)

- Add `base_ccy` (text, default `'GBP'`) to `portfolios`. Existing rows stay GBP.
- Add `cash_by_ccy jsonb` to `portfolios` (e.g. `{ "GBP": 12000, "USD": 4500 }`) alongside the existing scalar `cash`. Existing scalar remains the base-currency wallet.
- Add `instrument_ccy text` to `holdings`, `live_orders`, `pending_slices`, `trades`, and `decisions` so every row records the currency it was priced in.
- Extend `getFxRate` (already in `src/lib/fx.server.ts`) with a small `convert(amount, from, to)` helper and a bulk `getFxMatrix(pairs[])` used by the pricing layer.
- Refactor `src/lib/derive-card-equity.ts` and equity-snapshot writers to accept multi-currency holdings and convert into `base_ccy` at snapshot time; the equity headline stays in `base_ccy`.
- Tests: unit tests for `convert`, matrix caching, multi-ccy holdings valuation, and a golden-file test that GBP-only portfolios produce identical equity numbers post-migration.

### Phase B — Cross-currency equity trades (biggest cause of current InsufficientCash errors)

- In `src/lib/live-executor.server.ts`, before sizing a buy in a foreign currency, look up broker cash in that currency; if zero, plan an auto-conversion leg from `base_ccy` using Saxo's `/trade/v2/orders` with FX SPOT AssetType.
- Extend `trimBuysToBudget` with a `perCurrencyBudget` mode: instead of one scalar budget it takes `{ "USD": … , "EUR": … }` and trims each currency independently. Existing single-currency callers keep working via a thin wrapper.
- Add a `fx-conversion.server.ts` module that submits FX conversion orders through Saxo, waits for fill, and logs `FX_CONVERT` broker-log entries (source, rate, fee, net delivered).
- Surface FX legs in the **Errors** tab and **Audit** tab so any auto-conversion appears next to the equity trade it enabled.
- Tests: `pre-place-budget-per-currency.test.ts`, a mocked-broker integration test that a USD buy from a GBP-only wallet triggers a GBP→USD conversion first, and a failure-path test (FX conversion rejected → equity buy skipped, not attempted with insufficient USD).

### Phase C — Spot FX pairs as tradable instruments

- New symbol format `FX:EURUSD` recognised across the AI proposer, the broker adapter, the Saxo instrument-search cache, and the confidence pipeline. Mapped to Saxo `AssetType=FxSpot` and the matching Uic.
- Update `saxo.server.ts` `placeOrder` to build FX orders (Amount is base-currency units of the pair's base leg; no `Ccy` conversion needed).
- Extend `src/lib/risk-halts.server.ts` with an FX-notional cap so the AI can't take an FX position larger than a configurable % of NAV.
- Add an FX watchlist section on the portfolio page and let the AI include FX pairs in its decision set (behind a per-portfolio `fx_enabled` flag defaulting to off — you opt each portfolio in).
- Tests: FX order shape contract test against a recorded Saxo request, position-tracking round-trip (open EURUSD, close EURUSD, realised P&L in `base_ccy`), and a rejection test for an FX pair not in the enabled list.

### Phase D — Manual "Convert cash" tool

- A small dialog on each portfolio card: pick from-ccy, to-ccy, amount → shows live rate (from `getFxRate`), a fee estimate, and the delivered amount → posts an FX SPOT conversion via the Phase B FX-conversion module.
- Logs to `sim_fund_events` (for SIM) or `live_broker_log` + `FX_CONVERT` (for live) so the ledger stays consistent.
- Guardrail: dialog is blocked while risk halts are active or while another FX leg is in flight for the same portfolio.
- Tests: component test (dialog validation), and a wiring test that a successful conversion updates `cash_by_ccy` and appears in the audit log.

## What I would not do in this pass

- No leveraged FX or margin — plain spot conversions only. Margin FX changes risk math significantly and warrants its own phase.
- No new charting for FX pairs beyond re-using the existing price chart component with the FX symbol.
- No changes to backtest engine to include FX pair PnL — flagged as a Phase E if you want it later.

## Technical notes

- Every new numeric column is `numeric` (not `double precision`) to keep FX math exact.
- `cash_by_ccy` is authoritative once populated; the scalar `cash` becomes a derived view (`cash_by_ccy ->> base_ccy`) to avoid two sources of truth.
- Saxo FX SPOT uses `AssetType='FxSpot'`, `Uic` from `/ref/v1/instruments`, and `Amount` in the base leg — I'll cache Uics in `saxo_instrument_cache` alongside equities.
- All FX conversion decisions go through the existing `provider-circuit` breaker so a Saxo FX outage cannot cascade into equity trading errors.

## Where to start

I recommend shipping **Phase A + Phase B first** — those directly kill the InsufficientCash class of errors you have been seeing, without introducing a brand-new asset class. Phase C (spot FX trading) and Phase D (manual convert) can then land as separate approvals.

Please confirm and tell me which phase(s) to start with.
