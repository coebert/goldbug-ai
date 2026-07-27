// Phase B — Adaptive execution guardrails driven by an AlgoRegimeSnapshot.
//
// Pure helpers consumed by BOTH the broker simulator and the live executor
// so the exact same policy (tighten participation, block new market buys
// when the regime is extreme) applies on paper and in production.
//
// Everything here is a pure function on plain data so it's trivially
// testable and safe to import from server function modules (no I/O).

import type { AlgoRegimeSnapshot } from "./algo-regime";

export type AlgoRegimeGuardDecision<T> = {
  /** Decisions/orders that survived the block-new-buys guard. */
  kept: T[];
  /** Decisions/orders the guard suppressed, paired with a human reason. */
  blocked: Array<{ item: T; reason: string }>;
};

/**
 * Partition an array of order-like items into `kept` and `blocked` based
 * on the snapshot's `multipliers.blockNewBuys` flag. Only BUY items are
 * ever blocked; SELLs (protective exits) always pass through so risk
 * reduction is never gated behind the regime guard.
 *
 * `sideOf` is provided by the caller so both simulator decisions
 * (`d.side === "BUY" | "SELL"`) and live executor orders
 * (`o.side === "buy" | "sell"`) can reuse the same primitive.
 */
export function partitionByAlgoRegime<T>(
  items: readonly T[],
  snapshot: AlgoRegimeSnapshot | null | undefined,
  sideOf: (item: T) => "buy" | "sell" | "BUY" | "SELL",
): AlgoRegimeGuardDecision<T> {
  const kept: T[] = [];
  const blocked: Array<{ item: T; reason: string }> = [];
  const block = !!snapshot?.multipliers.blockNewBuys;
  if (!block) return { kept: [...items], blocked };
  const reason = `algo_regime_${snapshot!.tier}:${snapshot!.reason}`;
  for (const it of items) {
    const s = String(sideOf(it)).toLowerCase();
    if (s === "buy") blocked.push({ item: it, reason });
    else kept.push(it);
  }
  return { kept, blocked };
}

/**
 * Resolve the effective `maxParticipationRate` after layering the algo
 * regime's recommended cap on top of the caller-supplied cap. Always
 * returns the STRICTER of the two so the regime can only tighten, never
 * loosen, the participation limit. `null` when neither side supplies a
 * cap (i.e. the caller wants unconstrained behaviour and the regime is
 * normal).
 */
export function effectiveMaxParticipation(
  callerCap: number | undefined | null,
  snapshot: AlgoRegimeSnapshot | null | undefined,
): number | null {
  const c = Number.isFinite(callerCap) && (callerCap as number) > 0
    ? Math.min(1, callerCap as number)
    : null;
  const r = snapshot && Number.isFinite(snapshot.multipliers.maxParticipation)
    && snapshot.multipliers.maxParticipation > 0
    ? Math.min(1, snapshot.multipliers.maxParticipation)
    : null;
  if (c === null && r === null) return null;
  if (c === null) return r;
  if (r === null) return c;
  return Math.min(c, r);
}
