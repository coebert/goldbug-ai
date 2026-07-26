# Crypto Trading Strategy — Evidence & Design

_Last updated: 2026-07-26_

This document is the single source of truth for **how and why** Aegis trades
cryptocurrency exposure. Every rule below is (a) grounded in a cited empirical
base rate or crisis case study, (b) encoded in a specific server-side module
so the AI cannot ignore it, and (c) covered by an automated test that will
fail the build if the rule regresses.

---

## 1. Instrument scope and rationale

Aegis trades crypto **only** via physically-backed, Saxo-tradable ETPs/ETNs
on cash accounts. This is a hard constraint — spot BTC/ETH, futures,
perpetuals, leveraged/inverse products, single-miner equities (MARA/RIOT/CLSK),
crypto-exchange stocks (COIN) and treasury proxies (MSTR) are all forbidden
substitutes.

| Group  | Symbols                     | Underlying           | Venue        |
|--------|-----------------------------|----------------------|--------------|
| BTC    | `BTCE.DE`, `ABTC.SW`, `VBTC.L` | Bitcoin (physical)  | XETRA/SIX/LSE|
| ETH    | `ZETH.SW`, `ETHE.DE`         | Ether (physical)     | SIX/XETRA    |
| Basket | `HODL.SW`                    | 21Shares Crypto Index| SIX          |

Enforced in [`src/lib/crypto-groups.ts`](../src/lib/crypto-groups.ts) and the
universe filter in [`src/lib/universe.server.ts`](../src/lib/universe.server.ts).
The forbidden list is asserted in
[`crypto-etp-saxo-placement.e2e.test.ts`](../src/lib/__tests__/crypto-etp-saxo-placement.e2e.test.ts).

**Why physical ETPs, not derivatives?**

* Saxo cash accounts cannot post variation margin — perps/futures would
  breach the account-type contract.
* Leveraged/inverse ETPs suffer path-dependent decay: 2018-22 backtests of
  2×BTC daily-reset products show terminal underperformance of the
  underlying by 30-60% in choppy regimes, even when the directional call
  was correct.
* Single-miner equities carry idiosyncratic operational risk (hash-rate
  competition, energy costs, dilution) that dominates the crypto-beta we
  actually want.

---

## 2. Role in the portfolio

Crypto is treated as a **high-beta risk-on satellite**, never a core
holding and never a diversifier.

* Empirical: BTC-QQQ 60d rolling correlation has averaged **~0.6 since 2020**
  and exceeded 0.8 during the 2022 tightening cycle. Crypto is not
  uncorrelated to tech; sizing it as if it were double-counts risk.
* Empirical: max drawdowns of the underlying have been **-83% (2018)**,
  **-77% (2022)**, and **-72% (2021→2022)** — an order of magnitude worse
  than the S&P. Sleeve caps are set accordingly.
* Empirical: forward returns are highest in **early-cycle / dovish-pivot**
  windows — Q1 2019, H2 2020, Q4 2023 all delivered >70% 90d returns from
  a risk-on regime bucket flip.

---

## 3. Sleeve caps (position sizing)

Encoded in `cryptoSleeveCapPct()` — [`crypto-strategy.server.ts`](../src/lib/crypto-strategy.server.ts).

| Risk level    | Sleeve cap (% of NAV) | Rationale (95th-pctile 30d drawdown of the sleeve) |
|---------------|-----------------------|----------------------------------------------------|
| Conservative  | **5%**                | Limits portfolio drawdown contribution to ~4%      |
| Balanced      | **10%**               | Limits portfolio drawdown contribution to ~8%      |
| Aggressive    | **15%**               | Limits portfolio drawdown contribution to ~12%     |

Additional stacking rules:

* Sleeve cap **stacks** with `asset_class_limits.crypto`; the smaller wins.
* Per-symbol Kelly cap is tightened to **15%** (vs 25% for equities)
  because realised vol on these ETPs is 2-3× the equity universe.
* New positions open at **1/3 of the per-symbol cap**, adding only after
  a ≥10% favourable move **and** trend gate C1 still true.
* BTC + ETH combined **≤80%** of the sleeve; Basket (`HODL.SW`) must
  hold the residual whenever sleeve > 5% of NAV.
* In the `caution` regime bucket the sleeve target is halved to
  `0.4 × cap` — locked in by
  [`crypto-strategy.test.ts › caution regime`](../src/lib/__tests__/crypto-strategy.test.ts).

---

## 4. Regime gating

Aegis's `RegimeLabel` (from `regime-detector.server`) is bucketed into
`risk_on`, `caution`, `risk_off` via `bucketRegime()`:

| Regime label     | Bucket    | Action                                         |
|------------------|-----------|------------------------------------------------|
| `bull_quiet`, `recovery` | `risk_on`  | Allow up to full sleeve cap             |
| `bull_volatile`, `correction` | `caution` | Halve sleeve, no fresh entries      |
| `bear`, `crisis` | `risk_off` | **HARD VETO** — exit every crypto symbol       |

The HARD veto is not advisory. In the `risk_off` bucket
`computeCryptoSleeveDecision()` overrides the LLM and forces
`action: "exit"` with `size_fraction_of_cap: 0` on every symbol.
Regression-tested in
[`crypto-strategy.test.ts › risk_off HARD veto`](../src/lib/__tests__/crypto-strategy.test.ts).

**Why?** The 2018 and 2022 drawdowns — both **>-70%** — began in
risk-off / rising-rate-shock regimes. Historical base rates say
"buy the dip" against a risk-off regime has **negative expected
90d returns** for crypto.

---

## 5. Entry triggers (need ≥2 of C1–C4, C5 is a hard veto)

Implemented in `computeCryptoSleeveDecision()`:

* **C1 Trend.** `close > SMA50` AND `SMA50 > SMA200`, RSI-14 ∈ [45, 70].
  Chasing `RSI > 75` has historical 30d mean-reversion odds ~65%.
* **C2 Regime.** Bucket must be `risk_on` (or `caution` for holds only).
* **C3 Macro liquidity.** DXY falling w/w OR 10y real yield falling OR
  Fed dovish-pivot flag in `market_events`.
* **C4 Cross-asset confirmation.** QQQ trending up AND VIX < 20 AND
  credit spreads stable/tightening. Crypto has never sustained a rally
  with tech and credit against it.
* **C5 Parabolic guard (HARD veto).** Reject any BUY if the ETP is
  >+50% over the trailing 60 sessions — parabolic entries have negative
  expected 90d returns in the 2013-2024 sample. Locked in by
  [`crypto-strategy.test.ts › parabolic guard`](../src/lib/__tests__/crypto-strategy.test.ts).

---

## 6. Exit ladder (X1–X6, enforced server-side)

| ID  | Trigger                                                | Action           |
|-----|--------------------------------------------------------|------------------|
| X1  | Close < SMA50 for 2 sessions                           | Trim 50%         |
| X2  | Close < SMA200                                         | Exit fully       |
| X3  | 2.5× ATR trailing stop hit                             | Exit / trim      |
| X4  | VIX > 25 AND credit spreads widening                   | Sleeve → 0       |
| X5  | +40% in any 30d window                                 | Take 25-50%      |
| X6  | Regime flip to `risk_off` / rising-rate shock          | Exit within 1 tick |

The exit ladder is enforced **independently** of what the LLM proposes.
Test coverage:
[`crypto-strategy.test.ts › trend break exits`](../src/lib/__tests__/crypto-strategy.test.ts)
and the multi-regime long-horizon replay in
[`crypto-sleeve-simulation.e2e.test.ts`](../src/lib/__tests__/crypto-sleeve-simulation.e2e.test.ts).

---

## 7. Pre-trade validation

[`crypto-validation.server.ts`](../src/lib/crypto-validation.server.ts)
runs before any order reaches the broker:

* Symbol in the approved list (rejects `BTC-USD`, `COIN`, `MSTR`, `MARA`, …).
* `saxo_instrument_cache` row exists, otherwise the order is auto-rejected
  (a cache-drift heal is attempted first via
  [`crypto-cache-sync.ts`](../src/lib/crypto-cache-sync.ts)).
* 20d ADV$ ≥ `min_adv_usd` and 14d ATR% ≤ `crypto_max_atr_pct`.
* Venue currently open (respects the market-hours gate).
* Lot size / min notional respected.

Covered by
[`crypto-pretrade-checks.test.ts`](../src/lib/__tests__/crypto-pretrade-checks.test.ts).

---

## 8. Cross-currency handling

Most approved ETPs quote in EUR/CHF/GBP but track BTC/USD or ETH/USD.
Consequences enforced upstream:

1. FX conversion is scheduled **before** the equity buy via the FX intent
   pipeline — no reliance on Saxo's cash sweep.
2. Terminal FX exposure is treated as USD-crypto for risk aggregation,
   regardless of listing currency, so a weak-USD thesis does not get
   double-counted.

---

## 9. Rotation limit

The crypto sleeve cannot rotate more than **once per week** without a
regime change cited in the rationale. This defeats the LLM's tendency to
churn on noise and matches the 2019-2024 result that weekly-or-slower
rebalanced crypto sleeves outperform daily-rebalanced ones after costs.

---

## 10. Empirical evidence — backtests shipped with the app

The full playbook is replayable via
[`runCryptoBacktest`](../src/lib/crypto-backtest.functions.ts) and the
[`CryptoBacktestCard`](../src/components/crypto-backtest-card.tsx) UI.
The engine ([`crypto-backtest.server.ts`](../src/lib/crypto-backtest.server.ts)):

* Applies **identical fees and slippage (10 bps/side default)** to the
  strategy **and** to the BTC / ETH / cash benchmarks so comparisons are
  apples-to-apples.
* Emits an equity curve, drawdown curve, per-symbol contribution table,
  and a benchmark comparison with CAGR, MDD, vol, Sharpe, and Δ-vs-sleeve.
* Verified in [`crypto-backtest.test.ts`](../src/lib/__tests__/crypto-backtest.test.ts).

Property-based invariants (drawdown ≤ risk-level ceiling, sleeve ≤ cap in
every step, no exposure in `risk_off`) are asserted across randomised
regime paths in
[`crypto-playbook-properties.test.ts`](../src/lib/__tests__/crypto-playbook-properties.test.ts).

---

## 11. Prompt integration

`formatCryptoSignalsBlock()` renders the computed sleeve state into the
LLM system prompt alongside `CRYPTO_PLAYBOOK`. This means the model sees:

* The regime bucket and any HARD VETO already in force.
* Per-symbol trend / RSI / 60d return / drawdown / recommended action.
* The exact `size_fraction_of_cap` the sizing pipeline will accept.

So the model cannot argue with the numbers — it can only choose within
the envelope the engine already computed.

---

## 12. Change control

Any change to sleeve caps, regime buckets, entry gates, or the exit
ladder **must** update the corresponding test in
`src/lib/__tests__/crypto-*` in the same commit. The CI test suite is
the enforcement mechanism; this document is the rationale trail.
