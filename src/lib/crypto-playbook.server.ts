// Detailed crypto-trading playbook injected into the AI's system prompt.
// Kept in a `.server.ts` file so the string never ships to the browser
// bundle. Referenced from `trading-engine.server.ts` alongside
// HISTORICAL / HEDGE_FUND / COMMODITY / FX playbooks.
//
// Scope: physically-backed crypto ETPs/ETNs that Saxo can route on cash
// accounts. Spot BTC/ETH, futures, perps, leveraged/inverse products and
// single-miner equities are all out of scope.

export const CRYPTO_PLAYBOOK = `
=== CRYPTO STRATEGY PLAYBOOK ===
You may allocate to crypto only via approved, Saxo-tradable, physically-backed
ETPs/ETNs already present in the candidate list. The groups are:

  BTC     — BTCE.DE, ABTC.SW, BTCW.L
  ETH     — ZETH.SW, ZETH.DE
  Basket  — HODL.SW (21Shares Crypto Basket Index ETP)

--- ROLE IN THE PORTFOLIO ---
1. High-beta risk-on satellite: crypto ETPs tend to lead broad risk assets in
   liquidity-expansion regimes and lag/underperform in tightening regimes.
   Size accordingly — never a core holding.
2. Weak-USD / dovish-pivot expression: crypto has historically rallied when
   real yields fall and DXY weakens (2019-Q1, 2020-H2, 2023-Q4).
3. NOT a safe haven, NOT a diversifier: correlation with QQQ has been > 0.6
   for most of the last 5 years. Do not treat crypto as an inflation hedge in
   the way gold is treated.

--- REGIME PLAYBOOK (map to the REGIME block already provided) ---
- Risk-on / expansion:      allow up to the crypto sleeve cap, prefer BTC.
- Early cycle / recovery:   allow — highest historical forward returns start here.
- Late cycle / bubble:      trim aggressively, tighten stops, avoid new adds.
- Recession / risk-off:     cut sleeve to zero. Do not "buy the dip" against
                            a risk-off regime — crypto drawdowns in these
                            regimes have been -60 to -80% historically.
- Rising-rate shock:        cut sleeve to zero (real-yield-driven tightenings
                            crushed crypto in 2018 and 2022).
- Disinflation with dovish pivot: overweight BTC then ETH.

--- ENTRY TRIGGERS (require at least TWO to fire before a BUY) ---
C1. Trend: price > SMA50 AND SMA50 > SMA200 on the ETP itself.
    RSI-14 between 45 and 70 (never chase RSI > 75 — historical mean-reversion
    odds inside 30 days are ~65%).
C2. Regime: current market_regimes row is 'risk_on' or 'early_cycle'.
    Explicit veto if regime is 'recession', 'risk_off' or 'rising_rate_shock'.
C3. Liquidity / macro: DXY falling week-over-week, OR 10y real yield falling,
    OR a Fed dovish-pivot flag in market_events.
C4. Cross-asset confirmation: QQQ trending up AND VIX < 20 AND credit spreads
    stable or tightening. Crypto rarely leads a lasting rally without high-beta
    tech confirming.
C5. Behavioural guard (HARD veto, not a trigger): reject any BUY if the ETP
    is > +50% over the trailing 60 sessions. Parabolic entries have negative
    expected 90d returns in the historical record.

--- SIZING ---
- Kelly cap is tightened to 15% (vs 25% equities) because realised vol on
  crypto ETPs is 2-3x the equity universe.
- Start any new crypto position at 1/3 of the per-symbol cap; add only after
  a 10%+ favourable move AND trend gate C1 still true.
- Total crypto sleeve never exceeds risk-level cap:
    conservative  5%
    balanced     10%
    aggressive   15%
  These caps stack on top of the asset_class_limits.crypto guardrail — the
  smaller of the two wins.
- BTC + ETH combined never exceed 80% of the sleeve; keep some Basket exposure
  when the sleeve is > 5% of NAV.
- Prefer BTC over ETH when regime confidence is only moderate — ETH has higher
  beta to risk sentiment and larger drawdowns.

--- EXIT TRIGGERS ---
X1. Price closes below SMA50 for two sessions -> trim 50%.
X2. Price closes below SMA200 -> exit fully (regime break).
X3. ATR-based trailing stop (already enforced by guardrails; keep it tight —
    2.5x ATR rather than 3x for equities).
X4. Macro invalidation: VIX > 25 AND credit spreads widening -> cut sleeve
    to zero regardless of trend.
X5. Parabolic profit-take: after +40% in any 30d window, take partial profits
    (25-50%). Mean-reversion base rate is high at those extremes.
X6. Regime flip to 'risk_off' / 'rising_rate_shock' -> exit within one tick.

--- FX & CROSS-CURRENCY NOTES ---
- Most Saxo crypto ETPs quote in EUR (XETRA), CHF/USD (SIX) or GBP (LSE).
  Route FX conversion pre-fund intents (see FX playbook) BEFORE the equity
  buy — do not rely on cash sweeps.
- A weak-USD thesis buying an EUR-denominated BTC ETP funded by GBP is fine,
  but note the ETP tracks BTC/USD, so the terminal FX exposure is USD-crypto,
  not EUR-crypto. Do not double-count FX conviction and crypto conviction.

--- LIQUIDITY & QUALITY GATES (server-enforced, respect them) ---
- 20d ADV$ below the crypto min_adv_usd threshold -> auto-rejected.
- 14d ATR% above crypto_max_atr_pct                -> auto-rejected.
- Symbols missing saxo_instrument_cache            -> auto-rejected.
If you propose a symbol that fails these gates you WASTE a slot in
max_new_positions_per_day. Prefer BTCE.DE / ZETH.SW / HODL.SW — they are the
most liquid Saxo-tradable crypto ETPs in the candidate list.

--- FORBIDDEN ---
- Do NOT propose spot BTC / ETH / SOL (BTC-USD, ETH-USD, SOL-USD) — those
  are NOT tradable through Saxo cash accounts.
- Do NOT propose futures, perpetuals, 2x/3x leveraged or inverse crypto ETPs.
- Do NOT substitute crypto-exchange equities (COIN) or single-miner stocks
  (MARA, RIOT, CLSK) or MicroStrategy (MSTR) as a proxy for physical crypto
  exposure — those are equity positions and have different risk drivers.
- Do NOT rotate the crypto sleeve more than once per week without a clear
  regime change cited in the rationale.

Cite the specific triggers (e.g. "C1+C2+C4, DXY -1.2% w/w, VIX 15")
in the order reason field whenever you propose a crypto BUY or SELL.
=== END CRYPTO STRATEGY PLAYBOOK ===
`;
