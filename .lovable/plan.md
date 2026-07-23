# AI Market Analyst & Paper Trader — v1 Plan

A web app that gives an AI a virtual £1000 pot and lets it decide what to buy/sell across global markets. Two modes: **Backtest** (replay history to prove the strategy) and **Live Paper** (daily decisions against real current prices). No real money, no borrowing, no leverage — the AI can only spend what's in the cash balance.

## What you'll be able to do

- Set a starting pot (default £1000) and a **risk level** (Conservative / Balanced / Aggressive) that controls position sizing, diversification, and how volatile an asset the AI is allowed to touch.
- Choose the **asset universe**: US stocks & ETFs, UK/EU stocks, major crypto (BTC, ETH, SOL, etc.), and commodities/FX (gold, oil, GBP/USD, EUR/USD).
- Run a **backtest** over a chosen date range (e.g. last 2 years) and see equity curve, drawdown, win rate, Sharpe ratio, and a trade log.
- Switch on **live paper trading** — once a day (after market close) the AI reviews positions, reads recent news, and places simulated buy/sell orders at the day's closing price.
- Browse a **dashboard**: current portfolio value, P&L vs. £1000, holdings, cash, trade history, and the AI's written rationale for each decision.
- Read the **AI's daily briefing**: a summary of what happened in the world and how it influenced the day's trades.

## Guardrails (hard rules the AI cannot break)

- Cash balance can never go negative — no borrowing, no margin, no shorting, no options.
- Total exposure ≤ 100% of portfolio value.
- Position size caps depend on risk level (e.g. Conservative = max 10% per asset, Aggressive = max 25%).
- No further money is ever added; once £1000 is gone, it's gone.

## Screens

1. **Setup** — starting pot, risk level, asset universe checkboxes, mode (backtest / live paper).
2. **Dashboard** — portfolio value, P&L, holdings table, cash, allocation chart.
3. **Decisions & Rationale** — chronological AI journal: what it saw, what it did, why.
4. **Backtest Report** — equity curve, key stats, per-trade log, comparison vs. buy-and-hold benchmark.
5. **Settings** — adjust risk, pause/resume the AI, reset the simulation.

---

## Technical section

### Stack
- **Frontend**: TanStack Start (existing), Tailwind, shadcn/ui, Recharts for equity curve & allocation.
- **Backend**: Lovable Cloud (Postgres + auth) for portfolio state, trades, decisions, news cache.
- **AI**: Lovable AI Gateway with `google/gemini-3.6-flash` for daily reasoning + news summarisation. Structured output (Zod schema) for trade orders.
- **Market data (free tiers)**:
  - Stocks/ETFs/FX/commodities: Yahoo Finance (unofficial) or Alpha Vantage (free key).
  - Crypto: CoinGecko public API.
- **News**: GDELT 2.0 DOC API (free, global, no key) + a couple of RSS feeds (Reuters, BBC Business), summarised & scored by the AI.
- **Scheduling**: `pg_cron` in Lovable Cloud → hits a public server route (`/api/public/daily-tick`) once a day with an HMAC secret.

### Data model (Cloud tables)
- `portfolios` — id, user_id, name, starting_cash, current_cash, risk_level, universe (jsonb), mode (`backtest`|`live`), status, created_at.
- `holdings` — portfolio_id, symbol, asset_class, quantity, avg_cost.
- `trades` — portfolio_id, symbol, side (`buy`|`sell`), quantity, price, executed_at, rationale_id.
- `decisions` — portfolio_id, run_date, briefing (text), rationale (text), model, raw_json.
- `price_cache` — symbol, date, ohlcv (avoid re-hitting APIs).
- `news_cache` — date, source, headline, url, summary, sentiment.
- `backtest_runs` — portfolio_id, start_date, end_date, final_value, sharpe, max_drawdown, metrics jsonb.

RLS: each user only sees their own portfolios. Standard `user_roles` + `has_role` pattern.

### Server functions (`createServerFn`, called from UI)
- `createPortfolio`, `updatePortfolio`, `resetPortfolio`.
- `runBacktest({ portfolioId, start, end })` — streams progress; loops day-by-day, calls the AI decision function per day using only data available up to that date.
- `getDashboard(portfolioId)` — returns holdings + latest prices + P&L.
- `getDecisionJournal(portfolioId)`.

### AI decision function (server-only)
Input assembled per tick:
- Portfolio state (cash, holdings, cost basis, risk level, universe).
- Recent price history for candidate symbols (technical features: 20/50/200-day MA, RSI, volatility).
- Top news of the last 24h, pre-summarised.
- Explicit guardrail prompt (no borrowing, position caps, cash constraint).

Output (structured JSON via AI SDK `Output.object`):
```
{ briefing: string, orders: [{ symbol, side, quantityOrPctOfCash, reason }] }
```
Orders are then validated in code (cap enforcement, cash check, symbol whitelist) before being written as `trades` and applied to `holdings`. Any order violating a rule is rejected and logged — the AI never touches state directly.

### Public cron endpoint
`/api/public/daily-tick` — HMAC-signed, called by pg_cron. Iterates over all live portfolios, fetches prices + news, calls the AI, executes vetted orders at the day's close price.

### Backtest engine
Same decision function, but fed historical slices. Runs in a server function with progress written to a `backtest_runs` row so the UI can poll.

### Risk-level mapping
| Level | Max position | Max asset classes | Volatility cap | Cash floor |
|---|---|---|---|---|
| Conservative | 10% | broad ETFs, blue-chip | low | 20% |
| Balanced | 15% | + individual stocks, majors crypto | medium | 10% |
| Aggressive | 25% | full universe | high | 0% |

### Out of scope for v1 (call out explicitly)
- Real brokerage execution (Alpaca/IBKR) — architecture leaves a `broker` adapter interface for later.
- Intraday trading, options, shorting, leverage.
- Tax accounting.

### Build order
1. Enable Lovable Cloud + schema + RLS.
2. Market data + news fetchers with caching.
3. AI decision function with structured output + guardrail validator.
4. Backtest engine + report UI.
5. Live paper mode + daily cron.
6. Dashboard, decision journal, settings polish.

### Honest caveat shown in the UI
A persistent banner: *"Simulation only. Past performance and backtests do not predict future results. Do not use this to make real investment decisions."*
