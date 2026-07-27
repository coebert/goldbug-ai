import type { TradeOutcomeRow } from "@/lib/trade-outcomes.functions";

export type TradeOutcomeSummary = {
  total: number;
  filled: number;
  partial: number;
  working: number;
  failed: number; // rejected + error + cancelled
  fillRatePct: number; // (filled + partial) / total * 100
  volumeFillRatePct: number; // Σ filled_qty / Σ requested_qty * 100
  avgSlippageBps: number | null; // volume-weighted, limit orders only
  slippageSampleCount: number;
  errorCount: number; // rejected + error
  cancelledCount: number;
};

const EMPTY: TradeOutcomeSummary = {
  total: 0,
  filled: 0,
  partial: 0,
  working: 0,
  failed: 0,
  fillRatePct: 0,
  volumeFillRatePct: 0,
  avgSlippageBps: null,
  slippageSampleCount: 0,
  errorCount: 0,
  cancelledCount: 0,
};

/**
 * Aggregate a set of trade-outcome rows into headline tiles: fill rate,
 * volume-weighted slippage in bps (limit orders only, vs the working limit),
 * and error counts. Pure — safe for tests and memoisation.
 */
export function summarizeOutcomes(
  rows: readonly TradeOutcomeRow[],
): TradeOutcomeSummary {
  if (rows.length === 0) return EMPTY;

  let filled = 0;
  let partial = 0;
  let working = 0;
  let errorCount = 0;
  let cancelledCount = 0;

  let reqQty = 0;
  let fillQty = 0;

  // Volume-weighted slippage in bps, signed so a positive value means
  // the fill was worse than the limit (paid more on a buy, sold lower on
  // a sell). Market orders and missing limits are skipped.
  let slipNumerator = 0;
  let slipWeight = 0;
  let slipSamples = 0;

  for (const r of rows) {
    switch (r.status) {
      case "filled":
        filled++;
        break;
      case "partially_filled":
        partial++;
        break;
      case "rejected":
      case "error":
        errorCount++;
        break;
      case "cancelled":
        cancelledCount++;
        break;
      default:
        working++;
    }

    reqQty += Math.max(0, r.quantity);
    fillQty += Math.max(0, r.filledQty);

    if (
      r.orderType === "limit" &&
      r.limitPrice != null &&
      r.limitPrice > 0 &&
      r.avgFillPrice != null &&
      r.filledQty > 0
    ) {
      const sign = r.side === "buy" ? 1 : -1;
      const bps = ((r.avgFillPrice - r.limitPrice) / r.limitPrice) * 10_000 * sign;
      slipNumerator += bps * r.filledQty;
      slipWeight += r.filledQty;
      slipSamples++;
    }
  }

  const total = rows.length;
  const failed = errorCount + cancelledCount;
  const fillRatePct = ((filled + partial) / total) * 100;
  const volumeFillRatePct = reqQty > 0 ? (fillQty / reqQty) * 100 : 0;
  const avgSlippageBps = slipWeight > 0 ? slipNumerator / slipWeight : null;

  return {
    total,
    filled,
    partial,
    working,
    failed,
    fillRatePct,
    volumeFillRatePct,
    avgSlippageBps,
    slippageSampleCount: slipSamples,
    errorCount,
    cancelledCount,
  };
}
