# Making portfolio valuation correct by construction

## What I found

The app already has good valuation building blocks — they just aren't the only path to a number. There are **7 independent places that write `equity_snapshots`**, and each one does its own arithmetic:

| Writer | GBX -> GBP applied? | FX applied? | Invariants checked? |
|---|---|---|---|
| `equity-snapshot-backfill.server.ts` | yes | yes | no |
| `equity-snapshot-revalue.server.ts` | yes | yes | no |
| `live-cash-sync.server.ts` | broker-authoritative | n/a | yes |
| `live-holdings-sync.server.ts` | broker-authoritative | n/a | no |
| `trading-engine.server.ts` (2 sites) | **no** | **no** | no |
| `sim-funds.server.ts` | n/a | n/a | no |

The two trading-engine sites do a bare `price x quantity` sum. That single pattern is the origin of the pence-inflation and USD-counted-as-GBP incidents. Meanwhile the canonical multi-currency valuer (`valueHoldings` in `multi-ccy-holdings.ts`) has exactly **two** callers, neither of which is a snapshot writer, and the invariant checker (`equity-invariants.ts`) is wired into one writer out of seven.

So each fix so far has been correct but local: it repaired one path while the other six kept their own copy of the rules. That is why the problem keeps returning in a new tile.

## The fix: one kernel, one gate, one shape

### 1. A single valuation kernel

Create `src/lib/valuation/kernel.ts` as the only function in the app allowed to turn holdings + prices + cash into an equity figure. It takes explicit inputs (holdings, price map, wallet, base currency, FX resolver, as-of timestamp) and returns a `ValuationResult` containing the totals **plus the full provenance**: per-symbol quote currency, unit divisor applied, FX rate and its source/age, and any fallback that was used.

It composes the existing, already-tested pieces rather than reinventing them — `instrument-ccy-rules.ts` for currency tagging, `market-price-units.ts` for the GBX divisor, `price-symbol.ts` for symbol normalisation, `valueHoldings` for the multi-currency sum. Nothing new is invented; the logic is simply given one front door.

### 2. A write gate no writer can bypass

Create `src/lib/valuation/write-snapshot.server.ts`. Every snapshot write goes through it, and it:

- refuses non-finite values, negative cash/holdings, and `total != cash + holdings` beyond tolerance (reusing `checkEquityInvariants`);
- refuses a total that moves more than a configurable multiple versus the prior snapshot unless the delta is explained by a recorded fund event (reusing `valuation-consistency.ts` logic, which currently only *reports* after the fact);
- records the provenance blob alongside the row so any suspect number can be explained without re-deriving it.

Rejections are logged and surfaced, never silently swallowed. Broker-authoritative values stay authoritative: they pass through the gate as a distinct source that skips the recompute check but still must satisfy the arithmetic invariants.

### 3. Migrate the seven writers

Convert each writer to `computeValuation()` + `writeEquitySnapshot()`. The trading engine's two sites and `live-holdings-sync` are the substantive changes; the rest are mechanical. Then add a lint-style guard test that fails if `.from("equity_snapshots")` with `insert`/`upsert` appears anywhere outside the gate module — this is what stops writer number eight from reintroducing the bug.

### 4. Close the units gap at the source

The GBX rule currently lives behind a hand-maintained allowlist of Vanguard tickers. Rather than widen the allowlist further, store the observed quote currency per symbol when a price is fetched, and have the kernel prefer that stored fact over the heuristic, falling back to the allowlist only for unseen symbols. A sanity band (a quote 50-200x off the trailing median for that symbol) flags a unit flip before it is ever multiplied by a quantity.

### 5. Golden-file regression suite

One fixture portfolio containing an LSE pence stock, an LSE pound-quoted ETF, a USD stock, a EUR stock, a JPY stock and a crypto pair, with pinned prices and FX rates, asserted end-to-end through kernel -> gate -> tile-facing derivation. Any change to units or FX that moves a number has to update the golden file deliberately. Plus a property test: valuation is invariant to holdings order, and scaling every quantity by k scales holdings value by exactly k.

### 6. Reconciliation as a standing check

A daily job re-derives every portfolio's latest snapshot from source data and compares against what is stored. A mismatch beyond tolerance raises an alert with the provenance diff attached, so drift is caught by the app rather than by you noticing a wrong tile.

## Sequencing

1. Kernel + provenance type, unit-tested standalone (no behaviour change yet)
2. Write gate + guard test
3. Migrate trading engine and live-holdings-sync (the two real offenders)
4. Migrate remaining writers
5. Observed-quote-currency store + sanity band
6. Golden-file and property suites
7. Daily reconciliation job and alerting

Steps 1-3 remove the recurring failure mode. Steps 4-7 make it hard to reintroduce.

## Technical notes

- No schema changes beyond a provenance column on `equity_snapshots` and a small observed-quote-currency table.
- Existing modules are reused, not replaced: `instrument-ccy-rules`, `market-price-units`, `multi-ccy-holdings`, `equity-invariants`, `valuation-consistency`, `price-symbol`.
- The gate is server-only; client tiles keep reading stored snapshots and never recompute.
- Backfill/revalue paths already do the right thing, so migrating them is low risk and mostly deletes duplicated code.
