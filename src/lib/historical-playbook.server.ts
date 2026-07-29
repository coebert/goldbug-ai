// Historical market playbook — 50 years of cross-referenced market regimes,
// crises, and technical base rates. Injected into the AI trading agent's
// system prompt as decision priors.
export const HISTORICAL_PLAYBOOK = `HISTORICAL PLAYBOOK — 50 years of market lessons (1975-2025). Use these base rates and analogies to sanity-check every decision. Weight recent evidence more, but never ignore regime.

REGIME RECOGNITION (identify first, act second):
  A. Disinflation / falling rates (1982-2000, 2009-2021): equities and long-duration assets (tech, growth, long bonds) tend to outperform. Buy-and-hold works; drawdowns short.
  B. Inflation shock / rising rates (1973-74, 1978-81, 2021-23): real assets (commodities, energy, gold, short-duration value) outperform; growth and long bonds punished. Cash is NOT trash.
  C. Recession / credit crunch (1974, 1980-82, 1990-91, 2001, 2008-09, 2020, 2022): defensives (staples, healthcare, utilities), gold, USD, short Treasuries dominate. Cyclicals and small-caps lag.
  D. Recovery / early cycle (1975, 1983, 1992, 2003, 2009, 2020-Q3): small-caps, cyclicals, EM, credit spreads tighten. Highest 12m forward returns historically start HERE, not at the peak.
  E. Late cycle / bubble (1999-00, 2007, 2021): narrow breadth, extreme valuations, retail euphoria, IPO/crypto mania. Trim winners, raise cash, avoid speculative entries.

CRISIS PATTERN LIBRARY (median lessons, not predictions):
  - 1973-74 OPEC oil embargo: S&P -48% peak-to-trough; energy +100%; gold $35→$200. Supply shocks lift commodities, crush multiples.
  - 1979-82 Volcker inflation fight: Fed funds to 20%; 2y recession; gold peaked $850 Jan 1980 then -65%. Don't chase last cycle's winners into a rate reversal.
  - Oct 1987 Black Monday: -22% in a day, fully recovered in ~2y. Single-day crashes without recession are buyable within months.
  - 1990 Iraq/Kuwait: oil doubled in 3mo, S&P -20%, recovered in 6mo. Geopolitical spikes fade fast unless they trigger recession.
  - 1997-98 Asia/LTCM/Russia: EM -60%, USD & Treasuries safe havens. EM contagion + strong USD = flight to quality.
  - 2000-02 dot-com: Nasdaq -78% over 2.5y; value +30% same period. Sector concentration at peak valuations is the single biggest loss risk.
  - 2007-09 GFC: S&P -57%, financials -84%, gold +25%, Treasuries +20%. Credit-stress signals (spreads, bank CDS) precede equity capitulation by weeks.
  - 2010, 2011, 2015-16, 2018-Q4: -12% to -20% pullbacks without recession, all recovered <12mo. No-recession corrections are opportunities.
  - Mar 2020 Covid crash: -34% in 33 days, full recovery in 5mo on massive fiscal+monetary response. Policy magnitude sets recovery slope.
  - 2022 stag-inflation: 60/40 portfolio -17% (worst since 1937) — stocks AND bonds fell together. Bonds are NOT a hedge in inflation regimes; commodities and cash are.
  - 2023-24 AI mega-cap concentration: top 7 stocks drove >60% of S&P return; breadth thin. Track equal-weight vs cap-weight; narrow leadership is a late-cycle tell.

TECHNICAL BASE RATES (from 50y of daily data):
  - RSI-14 <30 on major indices: median 60d forward return ~+6%, hit rate ~70% outside recession, ~40% during recession.
  - Price > SMA200 AND SMA50 > SMA200 (golden-cross regime): forward 12m return roughly double vs below.
  - VIX >30 (proxy: 20d vol spike >2x baseline): mean-revert bias; average 3m forward return positive but wide dispersion.
  - Momentum (12-1 month): most robust cross-sectional factor, but crashes sharply at regime turns (2009-Q2, 2020-Q2). Downweight momentum right after -20%+ drawdowns.
  - Value spreads at extremes (2000, 2020): mean-revert violently over 12-24 months.

NEWS / MACRO OVERLAY:
  - Fed policy pivots (dovish surprise): historically highest-alpha single event. Add risk.
  - 2y-10y yield-curve inversion: median lead to recession ~14 months. Not immediate; don't de-risk equities the day it inverts, DO de-risk cyclicals/small-caps 6-12mo later.
  - Oil >+50% in 6mo: recession odds rise sharply within 12mo (1973, 1979, 1990, 2008, 2022).
  - USD (DXY) strength: headwind for EM, commodities, US large-cap earnings.
  - War / geopolitical shocks: initial -5 to -10% then recovery within 3-6mo UNLESS oil/supply-chain damage sustains.
  - Elections: median election-year S&P return positive; volatility rises Sep-Oct.

BEHAVIORAL GUARDRAILS (avoid the classic mistakes):
  - Do NOT chase parabolic moves (>50% in <3mo) — mean-reversion odds high.
  - Do NOT sell into single-day panics without a confirming credit/macro signal.
  - Do NOT concentrate >25% in one theme even if trending (2000 dot-com, 2021 crypto, 2024 AI reminders).
  - Diversify across 2-3 uncorrelated asset classes when regime is uncertain.
  - When in doubt, raise cash. Cash is a position; optionality has value.

ALGO-DRIVEN MARKET REGIME (2010-present — modern microstructure):
A large share of daily volume is now algorithmic / AI-driven (HFT market makers, systematic macro, vol-targeting funds, index/CTA flow, retail options gamma). This produces recurring, previously rare patterns you must price in:
  - Flash Crash (May 6, 2010): S&P -9% in minutes, fully recovered same session. Liquidity providers withdrew simultaneously. Lesson: market orders in thin tape get filled at absurd prints; always cap slippage.
  - Vol-mageddon (Feb 5, 2018): short-vol ETPs (XIV) blew up as VIX doubled in a day. Cross-asset systematic de-leveraging cascaded. Lesson: vol-targeting funds ALL sell together when vol spikes — expect correlated de-risking.
  - Mar 2020 Covid gamma unwind: dealer short-gamma amplified the sell-off; realised vol > 80%. Lesson: option-driven feedback loops accelerate one-way moves; widen stops, cut size.
  - Jan 2021 GameStop / WSB meme-squeeze (case study): GME rose from ~$17 (Jan 4) to an intraday $483 (Jan 28) — roughly +2,700% in under four weeks — then round-tripped back below $50 within a fortnight. AMC, BBBY, BB, NOK ran in sympathy. Mechanics: (1) reported short interest >100% of float created a structural forced-cover setup; (2) coordinated retail buying on r/WallStreetBets concentrated in short-dated OTM calls, forcing dealers into a gamma squeeze (delta-hedge buying accelerated as spot rose); (3) social virality (DFV "YOLO" posts, Elon "Gamestonk!!" tweet Jan 26) collapsed information latency; (4) Melvin Capital lost ~53% in Jan-2021 and took a $2.75B rescue from Citadel/Point72 — a top-quartile fund was carried out on a single crowded short; (5) Robinhood's Jan 28 buy-side restriction (imposed by NSCC $3B collateral call, not a "conspiracy") broke the reflexive loop and marked the top. Fresh lessons beyond "don't chase parabolas":
      • Crowded shorts with short-interest >20% of float, high borrow fee, and low float ARE the setup — screen for and AVOID shorting them, and treat any long already held into that condition as a candidate to trim.
      • Options gamma is now a first-class price driver on single names: when weekly call open interest balloons and dealers are net short gamma, expect UP-side vol to compound; conventional mean-reversion sizing under-estimates the tail.
      • Social-media velocity (WSB mention counts, ticker trend velocity on X/Reddit/StockTwits) is a leading indicator of retail-mania regimes — treat a >5× baseline mention spike as a caution flag, not a buy signal.
      • Broker/plumbing risk is real: DTCC/NSCC collateral rules can freeze BUY-side liquidity on squeezed names. Never assume you can exit at posted prices during a mania; size so a 50% gap-down is survivable.
      • The unwind is faster than the ramp. From the Jan 28 peak, GME lost ~90% in 14 sessions. Chasing on day 3+ of a parabola is nearly always a losing trade even if the story "wins" long term.
      • Fundamentals reasserted eventually but on a multi-year timescale (GME's 2021 revenue was ~$6B vs a peak market cap of ~$33B implying >5x sales for a declining bricks-and-mortar retailer). Narrative can dominate for weeks; cash flow dominates for years.
  - Aug 5 2024 yen-carry unwind: Nikkei -12% overnight, VIX to 65, S&P recovered within a week. Lesson: cross-asset carry unwinds are fast and mostly retrace; do not panic-sell into the vacuum, but do NOT add on day-1 either.
  - Recurring "0DTE" gamma pins and afternoon reversals: intraday microstructure now dominates the last 30-60 minutes. Lesson: prefer end-of-day fills over lunchtime chases.

BASE RATES for algo-driven regimes:
  - Realised vol spikes (short-window > 2.5× 20d baseline) mean-revert median within 5-10 sessions; forward 1m return positive on average but with fat left tail.
  - Liquidity vacuum days (volume < 40% of 20d median) have ~2× the spread cost of normal days; participation-rate caps matter more than price.
  - Cross-sectional correlation spikes (avg |corr| > 0.7 across top holdings) indicate all-algos-exit: diversification stops working, tail hedges do.

BEHAVIOURAL RULES for algo-driven markets:
  - Never send market orders during a vol burst or the first 15 min of a gap-and-fade — use marketable-limit with a hard slippage cap.
  - Slice large orders (TWAP/VWAP) and cap participation at 2-5% of median volume when the algo-regime tier is elevated/extreme.
  - When correlation spike + vol burst fire together, cut new-buy size by 50%+ and BOOST tail-hedge notional; do not "buy the dip" with full size.
  - Whipsaw regimes punish trend-following: widen stops or step aside for 1-2 sessions rather than getting knife-caught on both sides.
  - Overnight gaps > 1.5× typical daily move that reverse ≥50% in the first hour: assume the opening print was liquidity-driven, wait for a second confirmation bar before acting.

Apply these lessons as PRIORS. When today's signals conflict with the historical base rate for the current regime, prefer the base rate unless the evidence is strong and multi-signal.`;
