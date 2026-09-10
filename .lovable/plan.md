# Why the account isn't making money — and what to change

## What the numbers actually say

Account: **My Portfolio**, started £10,293.72 on 24 Jul, now **£9,835.13** — down 4.5% in seven weeks.

The loss is **not** coming from bad stock picking. It is coming from an account that is
barely in the market and can't get its orders executed.

**1. The money is sitting in cash.**

| Date | Total | In shares | In cash |
|---|---|---|---|
| 10 Sep | £9,835 | £1,551 (16%) | £8,284 (84%) |
| 4 Sep | £9,886 | £717 (7%) | £9,169 (93%) |
| 20 Aug | £9,935 | £2,739 (28%) | £7,196 (72%) |

Average exposure since early August is roughly a quarter of the account. A book that is
75-90% cash cannot produce a return, but it still pays every fixed charge.

**2. Trading has effectively stopped.**

| Week | Trades |
|---|---|
| 27 Jul | 18 |
| 3 Aug | 19 |
| 10 Aug | 0 |
| 17 Aug | 1 |
| 24 Aug | 0 |
| 31 Aug | 1 |
| 7 Sep | 2 |

In the last 21 days the engine produced **1,467 "hold" decisions, 440 skips and 24 errors**
against 5 fills.

**3. Why every buy gets stopped — the four blockers, counted from the decision log**

- *"no broker order was recorded for this ticket"* — **24 times**, the single biggest bucket.
  The ticket is approved and then vanishes before the broker sees it.
- *Currency leg failures* — the account holds pounds; US shares need dollars. The dollar
  conversion fails three different ways: broker suitability rejection (7), "number of decimals
  exceeds configured value", and "630.62 is below the 1000 GBP minimum ticket". The result is
  `InsufficientCash` rejections from Saxo **while £8,284 sits idle**. There is also a stale
  short GBPUSD leg of -4,990 open since 21 Aug that nobody is managing.
- *Dealing budget exhausted* — the rolling allowance is 0.40% of NAV ≈ **£40**, and the log
  shows **£175.08 of £39.81 spent**, i.e. 4.4x over. On a £10k book £40 covers about three UK
  tickets, so one rebalance day locks out buying for weeks. This fires repeatedly.
- *Ticket too small for the fee floor* — rejections on notionals of £114, £125, £130, £195
  ("£3 minimum = 308-526bps round trip"). Sizing produces tickets that can never be viable,
  and they are thrown away instead of being sized up.

**4. The cost hurdle is caught in a doom loop.**

The net-edge gate demands 150-320bps of expected move; signals offer 110-260bps, so buys are
refused. That hurdle is derived from the account's *measured* 90bps round trip — but 90bps is
high **because the tickets are tiny** (a £3 minimum on a £195 ticket is 154bps on its own).
Small tickets → high measured cost → higher hurdle → fewer and smaller tickets. The gate is
calibrating on its own damage.

**5. Data defects distorting the decisions**

- BP.L fill recorded with gross **£84,730** on a £10k account — pence stored as pounds (GBX).
- Three risk halts fired citing *"daily loss -17.14%, drawdown 20.07%"* when the true drawdown
  was under 5% — a phantom halt that stopped trading on those days.
- 9 orders errored on fixable broker-integration faults: missing `ManualOrder` flag, invalid
  AccountKey, tick-size violations, unknown instruments (VMID.L, VUKE.L, GBPEUR=X), rate limit.
- 20 of 24 fills carry `fee_source: none` — no cost recorded at all, so the cost model is
  learning from a partial picture.

## What to change

### A. Fix execution first (nothing else matters until orders land)

1. **Currency funding.** Round FX amounts to the broker's decimal precision; aggregate the
   dollar requirement for a whole tick into one conversion so it clears the 1,000 GBP minimum;
   fall back to a GBP-listed equivalent when the FX leg is refused, rather than routing a buy
   that will bounce on `InsufficientCash`. Close or re-hedge the stale GBPUSD leg.
2. **"Never reached the broker".** Trace and repair the drop between approval and submission;
   record an explicit failure instead of a silent loss.
3. **Broker request faults.** Send `ManualOrder`, round limit prices to the instrument tick
   size, resolve the AccountKey from the live session, and drop unresolvable symbols from the
   universe rather than retrying them.
4. **GBX correction** on fill capture, so pence-quoted LSE fills stop poisoning cost, P&L and
   drawdown maths — which also removes the phantom risk halts.

### B. Make the sizing coherent so tickets are viable

5. **Size up to the viable floor instead of rejecting.** When a ticket lands under the
   fee-viable notional but the idea passes on merit and cash allows, raise it to the floor.
   Refuse only when the floor breaks a real limit (cash, single-name cap).
6. **Widen the single-name cap for funds.** A 15% cap on a £10k book means £1,475 per name;
   broad ETFs (VWRL/VUSA) are not single-name risk and should sit under a higher cap so the
   account can actually be invested.

### C. Loosen the throttles that are choking the account

7. **Rolling dealing budget:** scale it to activity rather than a flat 40bps — floor it at a
   fixed number of viable tickets and let it refill continuously instead of collapsing to zero.
8. **Cost hurdle:** compute the measured round-trip cost from tickets **at or above the viable
   size**, so the hurdle stops inheriting the penalty of trades the app should never have
   attempted.
9. **Target exposure.** Add an explicit investment target (e.g. 70-85% invested in normal
   conditions) that the engine works toward, so persistent idle cash is itself treated as a
   problem to fix rather than a neutral state.

### D. Prove it before it trades

10. Re-run the shadow backtest on real prices with the fixes applied and compare against the
    current settings, so the changes are accepted on evidence rather than intuition.

## Order of work

Section A is the priority — the app currently cannot reliably place a trade, and no tuning
improves that. B and C follow, then the backtest in D to confirm the combination before it
runs on live money.

## Technical notes

Files in scope: `src/lib/fx/*` and the FX spot path, `src/lib/trading-engine/live-executor.server.ts`,
`src/lib/brokers/saxo-*.ts`, `src/lib/cost-governor.ts` (`costBudgetPctOfNav`,
`DEFAULT_MAX_POSITION_PCT_OF_NAV`, `minTicketBase`), `src/lib/net-edge-gate.ts`
(`MEASURED_FLOOR_HEADROOM`, measured-cost input), `src/lib/execution-costs.server.ts`,
`src/lib/sizing-haircuts.ts`, `src/lib/risk-halts.server.ts`.
