# Crypto Sleeve Plan

Add a new asset class — **crypto exposure via Saxo-tradable ETPs/ETNs only** (no spot BTC/ETH, no futures, no leverage) — that plugs into the existing universe, ranker, risk-controls, and playbook infrastructure exactly like the commodity sleeve.

## Scope

**In:** BTCE.DE (BTCetc Physical Bitcoin), VBTC.L (WisdomTree Physical Bitcoin), ZETH.SW / ETHE.DE (Physical Ethereum), BCHN.SW (basket). Final list gated by what `saxo_instrument_cache` can actually resolve — anything not tradable in the user's Saxo account is auto-dropped.

**Out:** spot crypto, perpetuals, futures, 2x/3x/-1x products, single-miner equities as a proxy, MSTR/COIN as a proxy.

## Files to add / change

### New
- `src/lib/crypto-groups.ts` — group definitions (`btc`, `eth`, `basket`), per-group risk caps, symbol → group map. Mirrors `commodity-groups.ts`.
- `src/lib/crypto-playbook.server.ts` — the AI system-prompt injection describing regime rules, entry/exit triggers, sizing, forbidden actions. Structure mirrors `commodity-playbook.server.ts`.
- `src/components/crypto-exposure-card.tsx` — per-group exposure vs cap tile for portfolio overview.

### Modify
- `src/lib/universe.server.ts` — add crypto symbols, tradability check (must exist in `saxo_instrument_cache` AND venue currently in `market-hours` "always-open" category), liquidity gate (min ADV$, max ATR%).
- `src/lib/market-hours.ts` — add `CRYPTO_ETP` venue mapping to the underlying exchange hours (XETRA / LSE / SIX) — these are ETPs, not 24/7 spot.
- `src/lib/trading-engine.server.ts` — inject `CRYPTO_PLAYBOOK` into the system prompt alongside historical / hedge-fund / commodity / FX playbooks.
- `src/lib/risk-halts.server.ts` — add crypto-sleeve cap (default 5% low / 10% medium / 15% high risk) and per-group caps.
- `src/components/risk-controls-card.tsx` — expose a `crypto_tilt` slider (0 = off, default; up to sleeve cap).
- `src/routes/portfolio.$id.tsx` — mount `CryptoExposureCard` next to `CommodityExposureCard`.

### Migration
- One migration adding `crypto_tilt numeric default 0` and `crypto_sleeve_cap_pct numeric` to `portfolios`, with GRANTs preserved.

## Playbook (what triggers a crypto BUY)

The AI will only propose crypto when **at least two** of the following fire, mirroring the commodity gate style:

- **C1 Trend:** price > SMA50 > SMA200 on the ETP; RSI-14 between 45 and 70.
- **C2 Regime:** current `market_regimes` row is `risk_on` or `early_cycle` (never `recession`, `risk_off`, or `rising_rate_shock`).
- **C3 Liquidity/macro:** DXY falling week-over-week OR 10y real yield falling OR Fed pivot flag in `market_events`.
- **C4 Cross-asset confirmation:** QQQ trending up AND VIX < 20 AND credit spreads stable/tightening.
- **C5 Behavioural guard:** reject if the instrument is >50% up in the last 60 trading days (parabolic filter).

**Exits:** close below SMA50 for 2 sessions → trim 50%. Close below SMA200 → exit. VIX > 25 with widening spreads → cut sleeve to zero. Parabolic +40% in 30d → take partial profits.

**Sizing:** start at 1/3 of per-symbol cap; sleeve capped by risk level as above; Kelly cap tightened to 15% (vs 25% for equities) because of higher realised vol.

## Guardrails already inherited (no new code needed)
- Correlation-cluster cap will naturally group BTC/ETH together (they run > 0.7).
- Precheck via Saxo `precheck` API before submission.
- FX matrix guard — most crypto ETPs quote EUR/USD/GBP; existing FX conversion logic applies.
- Post-broker reconciliation confirms fills.

## Technical notes

- `crypto-playbook.server.ts` stays in `.server.ts` so the string never ships to the browser bundle (same rule as commodity playbook).
- Symbol resolution guarded by `saxo_instrument_cache` — if the user's Saxo entitlements don't include crypto ETPs, the universe filter drops them silently and the ranker never sees them, so nothing breaks.
- No changes to `client.ts`, `types.ts`, or auth files.

## Out of scope (call out explicitly)
- No spot crypto wallets, no on-chain, no self-custody, no Coinbase/Binance connectors.
- No new backend for price feeds — the existing Yahoo/Frankfurter/price_cache path already handles ETP tickers.

## Verification
- Unit test: `src/lib/__tests__/crypto-universe.test.ts` — asserts crypto symbols only surface when in `saxo_instrument_cache` and when regime is risk-on/early-cycle.
- Unit test: `src/lib/__tests__/crypto-sleeve-cap.test.ts` — asserts sleeve cap and per-group cap reject oversized proposals.
- Manual: trigger an hourly run on a SIM portfolio with `crypto_tilt = 10%` and confirm a BTCE.DE proposal appears in `decisions` with the C1+C2 trigger cited in `reason`.
