# Daily report: explain why the account value moved

Today the daily report only covers trades made and passed on. Add a section that explains
the change in the account's value, whether that pattern looks likely to continue, and how
the AI is already reacting to it.

## What you'll see

A new block at the top of each portfolio in the Daily AI report:

- **Value change** — what the account is worth, how much it moved that day, and over the
  last week and month, with money you paid in or took out removed first.
- **What moved it** — the split between your positions, currency hedge legs and broker
  charges, plus the three holdings that helped most and the three that hurt most (each
  with its own contribution in pounds).
- **Is this likely to continue** — a plain-English read based only on measured evidence:
  how long the current run has lasted, how choppy the account has been, how much of the
  move came from one holding, and the market regime the engine recorded that day. Framed
  as a likelihood, never a promise.
- **How the AI is reacting** — the concrete settings the value change is already feeding:
  distance from the drawdown limit, how much of the day's money budget and friction budget
  is left, how much cash is deployed versus the target, whether any halt or cooldown is
  active, and whether the loss memory for a symbol has tightened its stops.

The AI's written summary is extended to cover the same ground in the same order, so the
narrative and the numbers agree. When a figure is missing it says so instead of guessing.

## Technical notes

- New pure module `src/lib/daily-report-equity.ts`: types plus arithmetic for the window
  totals, per-holding contributions, persistence read (run length, realised volatility,
  concentration of the move) and the deterministic sentences. Unit-tested.
- New `src/lib/daily-report-equity.server.ts`: loads `daily_equity_changes` (day, 7d, 30d),
  `live_fills` fees, FX leg moves and `price_cache` closes × held quantity for the mover
  attribution, and reads current guardrail state (risk halt, cost-governor friction budget,
  daily notional headroom, deployment vs target, per-symbol loss memory).
- `src/lib/daily-report.server.ts`: `DailyReportPortfolio` gains an `equity` field; the
  deterministic narrative and the Gemini prompt both gain the four new sections. Back-dated
  reports use the stored change rows for that date and omit live-only state, same rule the
  FX legs already follow.
- `src/routes/daily-report.tsx`: render the new block above the trades, reusing the existing
  card/badge styling and semantic colour tokens.
- No change to trading behaviour — this is reporting on rules that already run.
