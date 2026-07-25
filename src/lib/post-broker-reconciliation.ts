// Post-broker reconciliation.
//
// After the executor has (a) submitted every planned FX spot leg and
// (b) placed every routable order, this pure function walks each buy and
// verifies that:
//
//   1. every FX leg the trimmer planned for that buy's currency was placed
//      successfully (or the buy needed no FX leg at all), AND
//   2. the buy itself did not skip / error / reject at the broker.
//
// A buy that satisfies both is `fully_funded`. Anything else is `failed`,
// with a single deterministic reason string picked in this precedence:
//
//   pre-skip reason  >  broker reject reason  >  missing FX leg
//   >  failed FX leg  >  order not filled
//
// This runs OFF the wire — no Supabase, no adapter. The executor collects
// the routed order results and the planned FX legs / spot outcomes it
// already has in scope and hands them to `reconcileBuysWithFxLegs`. The
// audit-log insert is done by the caller, one row per entry, so the pure
// output is trivially unit-testable and mockable in e2e tests.

export type ReconStatus = "fully_funded" | "failed";

export interface PlannedFxLegLite {
  triggeredBySymbol: string;
  fromCcy: string;
  toCcy: string;
  amountFrom: number;
  amountTo: number;
  rate: number;
  stale: boolean;
}

export type FxLegOutcome =
  | { triggerSymbol: string; kind: "ok" }
  | { triggerSymbol: string; kind: "failed"; reason: string };

export interface RoutedBuy {
  symbol: string;
  side: "buy" | "sell";
  /** From the broker call: "filled" | "submitted" | "accepted" | "rejected" | "error" | "skipped" | "pending" | "duplicate" */
  status: string;
  /** Broker's reject reason, when the placement itself failed. */
  reason?: string;
  /** Pre-skip note ("preflight ...", "fx spot failed: ...", trim skip reason, etc.). */
  skipped?: string;
}

export interface ReconEntry {
  symbol: string;
  status: ReconStatus;
  reason: string | null;
  /** Number of FX legs the trimmer expected for this buy. */
  expectedFxLegs: number;
  /** Number of expected legs whose spot placement succeeded. */
  fulfilledFxLegs: number;
  /** Pass-through of the broker's terminal status for this order. */
  orderStatus: string;
}

const SUCCESSFUL_ORDER_STATUSES = new Set([
  "filled",
  "submitted",
  "accepted",
  "working",
  "pending",
]);

/**
 * @param routed          the executor's per-order results (buys + sells)
 * @param plannedFxLegs   the final `trim.fxLegs` after any re-trim (i.e. the
 *                        FX legs that were actually submitted)
 * @param fxOutcomes      one outcome per placed leg, keyed by triggerSymbol
 */
export function reconcileBuysWithFxLegs(
  routed: readonly RoutedBuy[],
  plannedFxLegs: readonly PlannedFxLegLite[],
  fxOutcomes: readonly FxLegOutcome[],
): ReconEntry[] {
  // Index outcomes per (triggerSymbol, fromCcy, toCcy) pair. A single symbol
  // can, in principle, have multiple legs (multi-hop), so we count matches
  // by successful-outcome COUNT per trigger, not by pair equality.
  const okCountByTrigger = new Map<string, number>();
  const failedByTrigger = new Map<string, string>();
  for (const o of fxOutcomes) {
    if (o.kind === "ok") {
      okCountByTrigger.set(o.triggerSymbol, (okCountByTrigger.get(o.triggerSymbol) ?? 0) + 1);
    } else {
      // First failed leg wins for the failure reason.
      if (!failedByTrigger.has(o.triggerSymbol)) {
        failedByTrigger.set(o.triggerSymbol, o.reason);
      }
    }
  }

  // Group planned legs by triggering symbol, preserving order.
  const legsByTrigger = new Map<string, PlannedFxLegLite[]>();
  for (const leg of plannedFxLegs) {
    const arr = legsByTrigger.get(leg.triggeredBySymbol) ?? [];
    arr.push(leg);
    legsByTrigger.set(leg.triggeredBySymbol, arr);
  }

  const out: ReconEntry[] = [];
  for (const r of routed) {
    if (r.side !== "buy") continue;
    const expected = legsByTrigger.get(r.symbol) ?? [];
    const expectedCount = expected.length;
    const okCount = Math.min(okCountByTrigger.get(r.symbol) ?? 0, expectedCount);
    const failedReason = failedByTrigger.get(r.symbol) ?? null;

    // 1) Pre-placement skip beats anything the broker could have said.
    if (r.status === "skipped") {
      out.push({
        symbol: r.symbol,
        status: "failed",
        reason: r.skipped ?? "pre-placement skip",
        expectedFxLegs: expectedCount,
        fulfilledFxLegs: okCount,
        orderStatus: r.status,
      });
      continue;
    }

    // 2) Broker-side rejection / error.
    if (r.status === "rejected" || r.status === "error" || r.status === "duplicate") {
      out.push({
        symbol: r.symbol,
        status: "failed",
        reason: r.reason ?? r.skipped ?? `order ${r.status}`,
        expectedFxLegs: expectedCount,
        fulfilledFxLegs: okCount,
        orderStatus: r.status,
      });
      continue;
    }

    // 3) FX leg didn't cover the buy. This shouldn't happen if the executor
    // re-trimmed correctly, but if any expected leg failed OR is missing an
    // outcome we surface it as a funding failure, not a silent pass.
    if (expectedCount > 0 && (failedReason || okCount < expectedCount)) {
      const reason =
        failedReason ??
        `expected ${expectedCount} FX leg${expectedCount === 1 ? "" : "s"} but only ${okCount} placed`;
      out.push({
        symbol: r.symbol,
        status: "failed",
        reason,
        expectedFxLegs: expectedCount,
        fulfilledFxLegs: okCount,
        orderStatus: r.status,
      });
      continue;
    }

    // 4) Order landed in a non-failure state and every planned FX leg
    // placed successfully → fully funded.
    if (SUCCESSFUL_ORDER_STATUSES.has(r.status)) {
      out.push({
        symbol: r.symbol,
        status: "fully_funded",
        reason: null,
        expectedFxLegs: expectedCount,
        fulfilledFxLegs: okCount,
        orderStatus: r.status,
      });
      continue;
    }

    // 5) Unknown terminal status — treat as failed rather than silently
    // reporting funded. Keeps the reconciliation defensive against future
    // adapter status values.
    out.push({
      symbol: r.symbol,
      status: "failed",
      reason: r.reason ?? `unrecognised order status: ${r.status}`,
      expectedFxLegs: expectedCount,
      fulfilledFxLegs: okCount,
      orderStatus: r.status,
    });
  }
  return out;
}
