# Aegis Clarity & Beginner Usability Plan

Goal: make the app understandable to someone who has never traded before, without dumbing down the underlying tooling. Every jargon term becomes clickable and reveals a short, plain-English explanation.

## Findings from the current UI

- **Dense jargon everywhere**: Sharpe, Drawdown, CAGR, Volatility, Alpha, RSI, SMA, ATR, slippage, regime, guardrails, conviction, backtest vs live_sim vs live_prod, universe, inverse-volatility sizing, take-profit, stop-loss, refresh token, OAuth.
- **No onboarding safety net past the £1000 wizard**: once you leave `/get-started`, terms appear cold with no hover/tap help.
- **Metrics tiles (CAGR / Sharpe / Vol / Drawdown)** show numbers with no "what does good look like?" anchor.
- **Risk Controls card** exposes advanced levers (per-asset caps, inverse-vol sizing, ATR trailing) with no explanation of trade-offs.
- **Decision & Signal Importance panels** show weights and rationales assuming the reader knows what RSI/SMA mean.
- **Admin / Saxo / OAuth pages** use developer language ("refresh token", "client_id", "callback") with no beginner framing.
- **Mode language is inconsistent**: badges say "Simulated cash · live" while the underlying value is `live_sim` — clearer now, but the difference between backtest / live-sim / real money is still not spelled out on first view.
- **No global "What am I looking at?" help** — a first-time user has no way to learn the vocabulary in-place.

## Solution shape

One reusable **Explain** primitive plus a **central glossary**. Any term in the app becomes clickable; a popover shows a plain-English definition, a "why it matters" line, and (where useful) a rule-of-thumb range. Same component works on desktop (click/hover) and mobile (tap).

## Step-by-step implementation

### Step 1 — Glossary data + Explain component
- Add `src/lib/glossary.ts` with entries keyed by short id: `sharpe`, `drawdown`, `cagr`, `volatility`, `alpha`, `rsi`, `sma`, `atr`, `slippage`, `regime`, `guardrail`, `conviction`, `backtest`, `live_sim`, `live_prod`, `universe`, `inverse_vol_sizing`, `stop_loss`, `take_profit`, `position_size`, `benchmark`, `pnl`, `oauth`, `refresh_token`, etc. Each entry: `{ title, short, why, rule_of_thumb?, example? }`.
- Add `src/components/explain.tsx`: wraps children in a dotted-underline trigger; uses shadcn `Popover` (works on tap + click); shows title, plain-English body, "why it matters", optional range. Accessible: `aria-describedby`, keyboard focusable, `Esc` closes.
- Variant `<ExplainIcon term="sharpe" />` for tight metric tiles (small ⓘ button).

### Step 2 — Wire glossary into the highest-traffic surfaces
- **Home (`/`)**: mode badge tooltip, "risk level", "starting pot", "asset universe" checkbox group header.
- **Portfolio detail (`portfolio.$id`)**: metric tiles (CAGR, Sharpe, Volatility, Max Drawdown, Alpha), "Benchmark", "Equity curve", "Decision" card header, "Signal Importance" (RSI / SMA / news sentiment / price change each explained), "Guardrails".
- **Compare (`/compare`)**: metrics table header cells, "Divergence".
- **Long-horizon (`/long-horizon/$id`)**: "Regime", "Slippage", "Transaction cost", "Minimum trade size".
- **Risk Controls card**: "Max position", "Stop-loss", "Take-profit", "Inverse-volatility sizing", "Per-asset cap", "Cash floor".
- **Admin / Saxo / Reconnect**: "SIM vs LIVE", "Access token", "Refresh token", "Kill switch", "Callback".

### Step 3 — First-visit orientation
- Add a dismissible "New here? Read this first" banner on `/` that links to a `/learn` page.
- New route `src/routes/learn.tsx`: single scrollable page rendered from the same glossary data — grouped into *Money & modes*, *How the AI decides*, *Risk controls*, *Reading the charts*, *Broker connection*. Anchored so glossary popovers can offer "Read more →" that jumps here.
- Header nav gets a small **Learn** link.

### Step 4 — Plain-English rewrites where a popover isn't enough
- Rewrite section subtitles on portfolio detail, risk card, and diagnostics to lead with what the user gets, not the technique.
- Metric tiles get a one-line qualitative caption under the number ("Higher is better. Above 1.0 is generally considered good" for Sharpe, etc.), sourced from the same glossary entry so it stays in sync.
- Mode disclaimer line on portfolio header expands: "This portfolio uses **pretend** money — nothing you do here touches your bank or Saxo account."

### Step 5 — Onboarding tour polish
- Extend `/get-started` wizard with a final "You're ready — here's how to read your portfolio" step that highlights the 4 things a beginner should look at first (equity curve, latest decision, guardrails, mode badge), each linking into the glossary.

### Step 6 — Accessibility & mobile pass
- Ensure every Explain trigger has a visible focus ring, `role="button"`, and works with keyboard.
- Verify popovers don't clip inside cards on 375px viewports.
- Respect `prefers-reduced-motion` for popover animation.

### Step 7 — QA checklist
- Click every underlined term on Home, Portfolio detail, Compare, Long-horizon, Risk card, Admin — confirm popover opens and content is beginner-readable.
- Screen-reader smoke test on portfolio metrics.
- Verify no jargon left un-explained in the top 5 screens a new user touches.

## Technical details

- `src/components/explain.tsx` uses existing `@/components/ui/popover` (Radix); no new deps.
- Glossary is a plain TS object — no DB, no server fn. All frontend.
- No changes to trading logic, server functions, or migrations. This is a pure UI/clarity pass.
- New files: `src/lib/glossary.ts`, `src/components/explain.tsx`, `src/routes/learn.tsx`. Edits to `index.tsx`, `portfolio.$id.tsx`, `compare.tsx`, `long-horizon.$id.tsx`, `risk-controls-card.tsx`, `diagnostics-panel.tsx`, `admin.tsx`, `saxo-status.tsx`, `saxo-reconnect.tsx`, `app-header.tsx`, `get-started.tsx`.

## Out of scope (ask if you want these)

- Video walkthroughs or animated tours (Shepherd.js / Driver.js).
- Translating glossary into other languages.
- AI-generated per-portfolio "explain this to me" summaries (could be a follow-up using the existing Gemini gateway).

Approve this and I'll build Steps 1–4 in the first pass, then 5–7 as a follow-up.