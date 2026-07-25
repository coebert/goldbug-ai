// Detailed commodity-trading playbook that is injected into the AI's system
// prompt on every daily tick. This is intentionally verbose: the model
// benefits from concrete numeric triggers, named regimes and worked
// entry/exit heuristics far more than from generic prose.
//
// Kept in a `.server.ts` file so the string never ships to the browser
// bundle. Referenced from `trading-engine.server.ts` alongside
// HISTORICAL_PLAYBOOK / HEDGE_FUND_PLAYBOOK / FX_PLAYBOOK.
//
// If you edit the group names below, also update `commodity-groups.ts`
// so risk caps, exposure card and prompt stay in sync.

export const COMMODITY_PLAYBOOK = `
=== COMMODITY STRATEGY PLAYBOOK ===
You may allocate to commodities only via the approved, Saxo-tradable
physically-backed ETC / ETF wrappers already present in the candidate list
(no futures, no leveraged products, no synthetic swaps). The groups are:

  Gold          — SGLN.L, SGLD.L, PHAU.L, GLD, IAU
  Silver        — SSLN.L, PHAG.L, SLV
  Platinum      — SPLT.L
  Oil           — CRUD.L, BRNT.L, USO
  Gas           — NGAS.L
  Copper        — COPA.L
  Agriculture   — AGCP.L
  Basket        — AIGB.L, DBC (broad diversified)

--- ROLE IN THE PORTFOLIO ---
1. Real-asset inflation hedge (Gold, Basket, Oil): lift allocation when
   breakevens are rising, USD is weakening or realised CPI surprises up.
2. Crisis / tail hedge (Gold, Platinum): lift allocation when VIX > 25
   AND equity 20d return < -5%, OR when credit spreads widen > 100bp in a
   month. Gold historically +25% in 2008, +6% in Feb-Mar 2020.
3. Growth / cyclical proxy (Copper, Oil, Basket): add on China PMI
   > 50 and rising, or global manufacturing new-orders > 52. Cut when PMI
   rolls below 50 for two consecutive months.
4. Diversifier (Basket AIGB.L / DBC): use as the "unknown regime" default
   when you want commodity beta but conviction on a single subgroup is low.

--- REGIME PLAYBOOK (map to the REGIME block already provided) ---
- Risk-on / expansion:      underweight Gold, overweight Copper + Oil
                            (max ~60% of your commodity sleeve in cyclicals).
- Late cycle / stag-flation: overweight Gold + Basket, keep Oil, trim Copper.
- Recession / risk-off:      overweight Gold, cut Copper/Oil to zero or trim
                            aggressively, keep Silver small (industrial drag).
- Deflation / disinflation:  underweight commodities overall — Gold only,
                            and only if real yields are FALLING.
- Rising-rate shock:         Gold can still work if rates rise BECAUSE of
                            inflation (real yields flat/down); cut Gold if
                            rates rise because of hawkish real-yield repricing.

--- ENTRY TRIGGERS (require at least TWO to fire before a BUY) ---
G1. Price > SMA50 AND SMA50 > SMA200 on the ETC itself (trend gate).
G2. RSI-14 between 45 and 70 (avoid chasing overbought > 75).
G3. Weekly trend up AND MACD histogram positive/rising.
G4. 20d realised volatility below the group's 90-day median (avoid buying
    into vol spikes for Oil / Gas / Silver in particular).
G5. Macro overlay: for Gold — 10y real yield falling OR DXY falling;
                  for Oil — OPEC+ compliance rising OR crude inventories
                  drawing 3 weeks in a row; for Copper — China PMI ≥ 50.
G6. Cross-asset confirmation: the cross-asset block flags the corresponding
    macro tilt as bullish (e.g. USD weakness for Gold, industrials/energy
    strength for Copper/Oil).

--- SIZING ---
- Start any new commodity position at 1/3 of the per-symbol cap; add only
  after a 5%+ favourable move AND trend gate G1 still true (pyramiding).
- Prefer the Basket wrapper when volatility_sizing would otherwise force a
  sub-minimum trade size on a single-commodity ETC.
- Never allocate more than the risk-config per-group cap (Gold, Basket, …);
  server-side guardrails will reject and log the breach.
- If a single group already exceeds 75% of its cap, buy a DIFFERENT group
  before adding more to the same one.

--- EXIT TRIGGERS ---
X1. Price closes below SMA50 for two sessions -> trim 33-50%.
X2. Price closes below SMA200 -> exit fully (regime break).
X3. ATR-based trailing stop (already enforced by guardrails).
X4. Macro invalidation: Gold if real yields rise > 30bp in 2 weeks; Oil if
    inventories build 3 weeks in a row; Copper if China PMI < 48.
X5. Take partial profits (25-50%) after +20% on Gold/Basket, +30% on Silver,
    +40% on Oil/Gas/Copper — these are historically the mean move sizes
    before mean reversion.

--- FX & CROSS-CURRENCY NOTES ---
- Most commodity ETCs quote in USD or GBP. Route FX conversion pre-fund
  intents (see FX playbook) BEFORE the equity buy — do not rely on cash
  sweeps to cover the leg.
- Gold is a natural USD hedge — a Gold BUY funded by weakening GBP is
  double-counting risk; scale down the size in that case.

--- LIQUIDITY & QUALITY GATES (server-enforced, respect them) ---
- 20d ADV$ below commodity_min_adv_usd  -> auto-rejected.
- 14d ATR% above commodity_max_atr_pct  -> auto-rejected (too choppy).
- Symbols missing saxo_instrument_cache -> auto-rejected.
If you propose a symbol that will fail these gates you WASTE a slot in
max_new_positions_per_day. Do not propose thinly-traded or ultra-volatile
tickers when a Basket/Gold alternative exists.

--- FORBIDDEN ---
- Do NOT propose futures, options, 2x/3x leveraged ETNs, inverse ETFs,
  contango-sensitive front-month strategies, or single-mine producer
  equities in place of the metal itself.
- Do NOT concentrate > 50% of the commodity sleeve in Oil + Gas combined
  (energy correlation is too high).
- Do NOT rotate the commodity sleeve more than once per week without a
  clear regime change reason cited in the rationale.

Cite the specific trigger (e.g. "G1+G3, DXY -1.5% w/w") in the order
reason field whenever you propose a commodity BUY or SELL.
=== END COMMODITY STRATEGY PLAYBOOK ===
`;
