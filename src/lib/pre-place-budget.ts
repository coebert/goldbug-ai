// Pure affordability trimming used by the pre-placement cash reconciliation in
// `live-executor.server.ts`. Extracted so it can be unit-tested without a live
// broker: given the refreshed broker cash and an ordered list of BUY orders,
// walk the orders in the natural placement sequence and mark each one either
// as fully affordable or as "skipped: insufficient broker cash".
//
// SELL orders never consume cash — callers should filter them out and merge
// them back in after trimming.

export type BudgetOrder = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  /** Per-unit price in portfolio currency (what the AI sized against). */
  price: number;
};

export type BudgetDecision =
  | { kind: "allow"; order: BudgetOrder; notionalBrokerCcy: number }
  | { kind: "skip"; order: BudgetOrder; notionalBrokerCcy: number; reason: string };

export type TrimBuysResult = {
  decisions: BudgetDecision[];
  totalRequestedBrokerCcy: number;
  totalAllowedBrokerCcy: number;
  skippedCount: number;
};

/**
 * Walk buys in order, deducting each order's broker-currency notional from the
 * available broker cash. Once an order would push the running total past the
 * budget it is marked as skipped, and every subsequent buy is evaluated against
 * the remaining (untouched) budget so smaller follow-on buys can still fit.
 *
 * @param buys ordered buy orders (typically largest-notional first to prefer
 *             the highest-conviction placements)
 * @param brokerCashAvailable available cash reported by the broker, expressed
 *             in the broker account currency
 * @param fxRate portfolio-currency → broker-currency conversion rate
 * @param opts.safetyBufferPct fraction of broker cash held back (defaults to
 *             1%) so rounding, spreads, and commissions don't cause an
 *             InsufficientCash reject at the broker
 */
export function trimBuysToBudget(
  buys: BudgetOrder[],
  brokerCashAvailable: number,
  fxRate: number,
  opts?: { safetyBufferPct?: number },
): TrimBuysResult {
  const safetyPct = opts?.safetyBufferPct ?? 0.01;
  const rate = Number.isFinite(fxRate) && fxRate > 0 ? fxRate : 1;
  const rawBudget = Number.isFinite(brokerCashAvailable) ? brokerCashAvailable : 0;
  const budget = Math.max(0, rawBudget * (1 - safetyPct));

  let remaining = budget;
  let totalRequested = 0;
  let totalAllowed = 0;
  const decisions: BudgetDecision[] = [];

  for (const o of buys) {
    if (o.side !== "buy") continue; // defensive — callers should filter first
    const notionalPortfolioCcy = Math.max(0, o.quantity) * Math.max(0, o.price);
    const notionalBrokerCcy = notionalPortfolioCcy * rate;
    totalRequested += notionalBrokerCcy;

    if (notionalBrokerCcy <= 0) {
      decisions.push({
        kind: "skip",
        order: o,
        notionalBrokerCcy,
        reason: "zero notional",
      });
      continue;
    }

    if (notionalBrokerCcy <= remaining + 1e-6) {
      remaining -= notionalBrokerCcy;
      totalAllowed += notionalBrokerCcy;
      decisions.push({ kind: "allow", order: o, notionalBrokerCcy });
    } else {
      decisions.push({
        kind: "skip",
        order: o,
        notionalBrokerCcy,
        reason: `insufficient broker cash: needs ${notionalBrokerCcy.toFixed(2)}, ${remaining.toFixed(2)} remaining (of ${budget.toFixed(2)} budget)`,
      });
    }
  }

  return {
    decisions,
    totalRequestedBrokerCcy: totalRequested,
    totalAllowedBrokerCcy: totalAllowed,
    skippedCount: decisions.filter((d) => d.kind === "skip").length,
  };
}
