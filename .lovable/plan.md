# Wire Aegis for live investing (Saxo Bank)

## What this delivers

You keep everything you have today (paper mode, backtests, diagnostics, learning). On top of that, each portfolio gets a **Mode** switch:

- **Paper** (current default) — nothing changes.
- **Live** — the same AI decision loop, but orders go to your Saxo account.

Flipping Live is a deliberate two-step confirmation, and there is a big red **Kill switch** that pauses all live activity across every portfolio instantly.

## Saxo — what you need to do (once)

Saxo's API is OAuth2. To keep this practical for a personal app I'll wire it up with the **24-hour developer access token** flow first (Saxo → Developer Portal → "24-Hour Token"), and leave a clean upgrade path to full OAuth later. You'll:

1. Open a Saxo account (or use existing) and enable Developer Portal access.
2. Start in **SIM environment** (Saxo's free simulator with real market data) — I'll default the app to SIM. Live production requires flipping one env value.
3. Paste your 24h token into the app's secrets when prompted. You'll refresh it daily from Saxo's portal; the UI will show a countdown and warn 2h before expiry.

Full OAuth (auto-refreshing 30-day tokens) needs Saxo to approve an app registration — I'll build the adapter so we can turn that on later without touching the trading engine.

## Safety rails (all on by default)

- **SIM by default.** Live production requires a separate toggle inside the LIVE flow — not the same click.
- **Kill switch** — global; sets every live portfolio to `paused`, cancels open orders.
- **Guardrail re-check pre-submit** — the existing risk_config (per-asset cap, no leverage, stop-loss, take-profit) is enforced client-side by the AI AND server-side before every order is sent.
- **No margin, ever.** Adapter refuses any order that would require borrowed cash. Uses Saxo cash account order types only.
- **Order-size sanity caps** — reject any single order > 25% of portfolio, > 5x recent avg trade size, or below broker minimum.
- **Idempotency** — every AI decision gets a UUID; the adapter refuses to submit the same decision twice.
- **Reconciliation** — after every hourly run, pull actual Saxo positions + cash and reconcile against our DB; flag drift.
- **Full audit log** — every request/response to Saxo (with secrets redacted) stored in `live_broker_log`.

## What changes in the app

### Database (new migration)

- `portfolios.mode` extended: `paper | live_sim | live_prod` (default `paper`).
- `portfolios.broker` = `'saxo'` when live; `portfolios.broker_account_id` stored.
- `portfolios.live_paused` boolean (kill-switch state).
- New table `live_orders` — our intent (decision_id, symbol, side, qty, limit/market, status).
- New table `live_fills` — Saxo fills mapped back to orders.
- New table `live_broker_log` — audit trail of API calls.
- New table `live_reconciliation` — nightly snapshot of broker cash + positions vs our record, with `drift_flag`.

### Broker adapter

- `src/lib/brokers/adapter.ts` — interface: `getBalance`, `getPositions`, `placeOrder`, `cancelOrder`, `listOrders`, `ping`.
- `src/lib/brokers/saxo.server.ts` — Saxo implementation, uses `SAXO_ACCESS_TOKEN`, `SAXO_ENV` (`sim`|`live`). Handles instrument lookup (Uic), rounding to tick size, market-hours check.
- `src/lib/brokers/stub.server.ts` — dry-run adapter (already in spirit — logs only).

### Trading engine

- `runHourlyCycle` gains a branch: for portfolios with `mode != 'paper'`, after the AI produces a decision, call `submitLiveDecision(portfolio, decision)` instead of the paper trade writer.
- `submitLiveDecision` runs guardrails → creates `live_orders` row → calls adapter → writes `live_broker_log` → on fill webhook/poll, writes `live_fills` and updates `holdings` / cash from **broker-reported** values (source of truth).
- Global kill: if `live_paused=true` on the portfolio OR the global `LIVE_KILL_SWITCH` flag is set, engine short-circuits before any broker call.

### UI

- **Portfolio page** gains a "Live trading" card:
  - Mode selector (Paper / Live SIM / Live PROD) with distinct colours.
  - Broker connection status (token expiry countdown, last successful ping).
  - Live positions table (from Saxo, side-by-side with our DB — drift highlighted).
  - Recent live orders/fills stream.
  - Big red **Pause live trading** button (per portfolio) + global kill-switch in the header.
- **First-run wizard** for Live activation: 4-step modal — read risks, confirm SIM first, connect Saxo token, read broker balance and confirm starting capital.
- **Get Started** wizard gets a "Try live in SIM" branch after the paper run.

### Server routes / functions

- `src/lib/live.functions.ts` — `activateLive`, `deactivateLive`, `pauseLive`, `resumeLive`, `syncBrokerBalance`, `getLiveStatus`, `getLivePositions`. All `requireSupabaseAuth`.
- `src/routes/api/public/hooks/live-reconcile.ts` — nightly reconciliation (pg_cron @ 23:30 UTC, protected by `CRON_SECRET`).
- Existing `hourly-run.ts` gains the live branch (guarded — SIM by default until you flip PROD).

### Secrets to be added (when you're ready)

- `SAXO_ACCESS_TOKEN` — your 24h dev token.
- `SAXO_ENV` — `sim` (default) or `live`.
- `SAXO_APP_KEY` / `SAXO_APP_SECRET` — placeholder for later OAuth upgrade.

I'll only prompt for these the first time you click **Activate Live**.

## Technical details

- Saxo base URL: `https://gateway.saxobank.com/sim/openapi` (SIM) / `.../openapi` (live). Bearer auth via `Authorization: Bearer <token>`.
- Instrument lookup: `/ref/v1/instruments?Keywords=<symbol>&AssetTypes=Stock,Etf` → cache Uic per symbol in a new `saxo_instrument_cache` table (24h TTL).
- Order placement: `/trade/v2/orders` — cash account, `OrderType=Market` or `Limit`, `AmountType=Quantity`, `OrderDuration.DurationType=DayOrder`.
- Fills: poll `/port/v1/orders/me` + `/port/v1/positions/me` on each cycle; also subscribe to Saxo's ENS (Event Notification Service) later if we upgrade to full OAuth.
- Rate limits: Saxo publishes per-endpoint quotas; adapter uses a token bucket (60 req/min conservative default), logs 429s.
- Position sizing: unchanged — uses your existing risk_config; on Live activation we call `getBalance()` and set `portfolio.starting_cash` from broker cash (as you chose).
- No CFDs, no margin, no FX leverage — adapter rejects those instrument categories at the lookup step.

## What I will NOT do in this change

- No full OAuth flow (keeping it manual-token for v1; upgrade path documented in code).
- No options / futures / CFDs.
- No auto-refresh of the 24h token (Saxo doesn't allow it without app approval).
- No changes to the paper engine, backtests, or learning system.

## Order of implementation

1. DB migration (portfolios columns + 4 new tables + grants + RLS).
2. Broker adapter interface + Saxo implementation (SIM only initially).
3. `live.functions.ts` server functions + kill-switch.
4. Trading engine branch + guardrail re-check.
5. Portfolio UI "Live trading" card + kill-switch header button.
6. Live activation wizard + secrets prompt.
7. Reconciliation cron + audit log viewer.
8. Documentation card explaining the daily token refresh routine.

After step 2 the app is safe to deploy (nothing routes to Saxo yet). Live only becomes reachable after step 6 when you personally activate a portfolio.