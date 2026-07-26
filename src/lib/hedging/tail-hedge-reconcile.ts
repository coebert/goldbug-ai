// Phase 6 — tail-hedge reconciliation.
//
// Compares the advisory produced by `computeTailHedge` against what the
// executor actually applied (paper) or what the broker mirror currently holds
// (live). Emits a diff record for `decisions.raw.tail_hedge_reconciliation`
// so the audit trail shows slippage and, when the advisory was ignored, why
// (deferral, insufficient cash, no price, unknown symbol, etc.).
//
// Pure function — no I/O — so it can be unit-tested and called from both the
// paper and live paths in the trading engine.

import type { TailHedgeDecision } from "./tail-hedge";

export type TailHedgeAppliedLite = {
  applied: boolean;
  reason: string;
  symbol: string | null;
  qty: number;      // qty actually filled by the paper executor (0 for live pre-broker)
  notional: number; // notional actually filled at exec price
};

export type TailHedgeReconcileInputs = {
  decision: TailHedgeDecision;
  applied: TailHedgeAppliedLite;
  /** Current observed holding of the hedge symbol on this portfolio. */
  observedHedgeQty: number;
  observedHedgePrice: number | null; // may be null if no price
  isLivePortfolio: boolean;
  /** Previous decision's persisted targetNotional (advisory). */
  priorTargetNotional: number;
};

export type TailHedgeReconciliation = {
  advised: {
    action: TailHedgeDecision["action"];
    deltaNotional: number;
    targetNotional: number;
    targetPctNav: number;
  };
  applied: {
    applied: boolean;
    action: "buy" | "sell" | "hold" | "none";
    symbol: string | null;
    qty: number;
    notional: number;
    reason: string;
  };
  /**
   * Difference between what was advised and what actually got booked, in
   * broker/base currency (positive = under-hedged vs advisory).
   */
  slippage: {
    notionalDiff: number;                    // |advised| − |applied|, signed positive if under-filled
    pctOfAdvised: number;                    // 0..1 (or 0 when advised delta is ~0)
    kind: "none" | "partial" | "unfilled" | "over"; // over = executor filled more than advised (rare, e.g. rounding)
  };
  /**
   * When the advisory was NOT applied in full, this string captures the
   * reason bucket so alerting can group them: "live_broker_deferred",
   * "insufficient_cash", "no_price", "unknown_symbol", "no_position_to_sell",
   * "hold", "sub_dollar_delta", or null when the advisory was fully applied.
   */
  deferralReason: string | null;
  /**
   * Broker-authoritative drift: for LIVE portfolios the executor doesn't
   * mutate the local mirror, so the true fill only shows up in the next
   * broker sync. We surface the currently observed hedge notional so
   * dashboards can compare it against `advised.targetNotional`.
   */
  observed: {
    qty: number;
    price: number | null;
    notional: number;
    driftVsTarget: number; // observed − advised.targetNotional
  };
  priorTargetNotional: number;
};

/** Bucket the executor's free-form `reason` into an enum-ish deferral tag. */
export function classifyDeferralReason(
  decision: TailHedgeDecision,
  applied: TailHedgeAppliedLite,
): string | null {
  if (decision.action === "hold") return "hold";
  if (Math.abs(decision.deltaNotional) < 1) return "sub_dollar_delta";
  if (applied.applied) {
    // Fully applied advisories still count as "no deferral" even if the qty
    // was clipped by cash — slippage handles that quantitative side.
    return null;
  }
  const r = (applied.reason || "").toLowerCase();
  if (r.includes("live")) return "live_broker_deferred";
  if (r.includes("insufficient cash")) return "insufficient_cash";
  if (r.includes("no price")) return "no_price";
  if (r.includes("unknown hedge symbol")) return "unknown_symbol";
  if (r.includes("no ") && r.includes("to unwind")) return "no_position_to_sell";
  if (r.includes("computed sell qty is zero")) return "no_position_to_sell";
  return "other";
}

export function reconcileTailHedge(
  input: TailHedgeReconcileInputs,
): TailHedgeReconciliation {
  const advisedDelta = Math.abs(input.decision.deltaNotional);
  const filledDelta = input.applied.applied ? Math.abs(input.applied.notional) : 0;
  const rawDiff = advisedDelta - filledDelta;
  const pct = advisedDelta > 1e-6 ? Math.max(0, Math.min(1, rawDiff / advisedDelta)) : 0;

  let kind: TailHedgeReconciliation["slippage"]["kind"];
  if (advisedDelta < 1) kind = "none";
  else if (!input.applied.applied) kind = "unfilled";
  else if (rawDiff <= 1e-6 && rawDiff >= -1e-6) kind = "none";
  else if (rawDiff > 1e-6) kind = "partial";
  else kind = "over";

  const observedNotional = input.observedHedgePrice != null
    ? input.observedHedgeQty * input.observedHedgePrice
    : 0;

  const appliedAction: "buy" | "sell" | "hold" | "none" = input.applied.applied
    ? (input.decision.action === "hold" ? "hold" : input.decision.action)
    : (input.decision.action === "hold" ? "hold" : "none");

  return {
    advised: {
      action: input.decision.action,
      deltaNotional: input.decision.deltaNotional,
      targetNotional: input.decision.targetNotional,
      targetPctNav: input.decision.targetPctNav,
    },
    applied: {
      applied: input.applied.applied,
      action: appliedAction,
      symbol: input.applied.symbol,
      qty: input.applied.qty,
      notional: input.applied.notional,
      reason: input.applied.reason,
    },
    slippage: {
      notionalDiff: rawDiff,
      pctOfAdvised: pct,
      kind,
    },
    deferralReason: classifyDeferralReason(input.decision, input.applied),
    observed: {
      qty: input.observedHedgeQty,
      price: input.observedHedgePrice,
      notional: observedNotional,
      driftVsTarget: observedNotional - input.decision.targetNotional,
    },
    priorTargetNotional: input.priorTargetNotional,
  };
}
