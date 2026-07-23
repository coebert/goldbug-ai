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

Apply these lessons as PRIORS. When today's signals conflict with the historical base rate for the current regime, prefer the base rate unless the evidence is strong and multi-signal.`;
