// Consolidate per-buy FX funding legs into one conversion per currency pair,
// and top the amount up to the broker's minimum ticket when spare cash allows.
//
// Why: the trimmer emits one FX leg per triggering buy, so a tick that wants
// £300 of AAPL and £400 of MSFT posts two sub-minimum GBP->USD spot orders.
// Saxo's FX minimum is 1,000 units of the first currency, so both legs are
// rejected ("… is below the 1000 GBP minimum ticket") and BOTH buys are
// dropped — while thousands of pounds sit idle in the account.
//
// Two fixes, both pure:
//   1. Group legs by pair and sum them, so a tick converts once.
//   2. If the summed amount still misses the minimum, round it UP to the
//      minimum provided the wallet actually holds that much. The surplus
//      simply stays as foreign cash and funds the next buy in that currency,
//      which is strictly better than converting nothing at all.
//
// Execution and logging belong to the caller.

import type { FxLeg } from "./pre-place-budget-multi-ccy";

export type ConsolidatedFxLeg = {
  fromCcy: string;
  toCcy: string;
  /** Amount actually to be converted (>= `requiredFrom` when topped up). */
  amountFrom: number;
  amountTo: number;
  rate: number;
  stale: boolean;
  /** Every buy that depends on this conversion. */
  triggerSymbols: string[];
  /** Sum of the underlying legs' funding needs, before any top-up. */
  requiredFrom: number;
  /** True when the amount was raised to reach the pair minimum. */
  toppedUp: boolean;
  /** Set when the pair minimum could not be reached from available cash. */
  shortfallReason?: string;
};

export type ConsolidateOpts = {
  /** Minimum ticket in units of `fromCcy`. Saxo majors: 1,000. */
  minAmountFrom?: number;
  /** Spendable balance per currency, used to cap any top-up. */
  available?: Record<string, number>;
  /** Fraction of the balance we are willing to convert at most. */
  maxWalletShare?: number;
};

const DEFAULT_MIN = 1_000;
const DEFAULT_MAX_SHARE = 0.9;

export function consolidateFxLegs(
  legs: FxLeg[],
  opts: ConsolidateOpts = {},
): ConsolidatedFxLeg[] {
  const min = Math.max(0, opts.minAmountFrom ?? DEFAULT_MIN);
  const share = Math.max(0, Math.min(1, opts.maxWalletShare ?? DEFAULT_MAX_SHARE));
  const available = opts.available ?? {};

  const groups = new Map<string, ConsolidatedFxLeg>();
  for (const leg of legs) {
    const from = leg.fromCcy.toUpperCase();
    const to = leg.toCcy.toUpperCase();
    const key = `${from}->${to}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        fromCcy: from,
        toCcy: to,
        amountFrom: leg.amountFrom,
        amountTo: leg.amountTo,
        rate: leg.rate,
        stale: leg.stale,
        triggerSymbols: [leg.triggeredBySymbol],
        requiredFrom: leg.amountFrom,
        toppedUp: false,
      });
      continue;
    }
    existing.amountFrom += leg.amountFrom;
    existing.amountTo += leg.amountTo;
    existing.requiredFrom += leg.amountFrom;
    existing.stale = existing.stale || leg.stale;
    if (!existing.triggerSymbols.includes(leg.triggeredBySymbol)) {
      existing.triggerSymbols.push(leg.triggeredBySymbol);
    }
    // Blended rate keeps amountTo consistent with the summed amountFrom.
    existing.rate = existing.amountFrom > 0 ? existing.amountTo / existing.amountFrom : leg.rate;
  }

  for (const g of groups.values()) {
    if (min <= 0 || g.amountFrom >= min) continue;
    const cap = (available[g.fromCcy] ?? 0) * share;
    if (cap >= min) {
      g.amountFrom = min;
      g.amountTo = min * g.rate;
      g.toppedUp = true;
    } else {
      g.shortfallReason =
        `needs ${min} ${g.fromCcy} minimum but only ${cap.toFixed(2)} is spendable ` +
        `(wallet ${(available[g.fromCcy] ?? 0).toFixed(2)})`;
    }
  }

  return [...groups.values()];
}
