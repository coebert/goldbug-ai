// Phase C helper: given the result of `trimBuysToBudgetByCurrency` and the
// set of triggering-symbols whose broker-side FX spot placement failed,
// return the buys we are still allowed to submit. Pure — no IO.
//
// Rules:
// - A buy whose fxLeg failed is removed entirely (its funding never happened).
// - Buys with no fxLeg (already-funded in target ccy) survive untouched.
// - Buys whose fxLeg succeeded survive untouched.
//
// Callers should re-run `trimBuysToBudgetByCurrency` on the survivors so
// wallet math reflects only successful legs — this helper deliberately does
// not mutate the wallet itself.

import type {
  MultiCcyBudgetOrder,
  TrimBuysMultiCcyResult,
} from "./pre-place-budget-multi-ccy";

export type FxSpotOutcome =
  | { kind: "ok"; triggerSymbol: string; fillRate: number; amountTo: number }
  | { kind: "failed"; triggerSymbol: string; reason: string };

export function survivingBuysAfterFxSpot(
  originalBuys: MultiCcyBudgetOrder[],
  trim: TrimBuysMultiCcyResult,
  outcomes: FxSpotOutcome[],
): {
  survivors: MultiCcyBudgetOrder[];
  droppedSymbols: Map<string, string>;
} {
  const failed = new Set(
    outcomes.filter((o) => o.kind === "failed").map((o) => o.triggerSymbol),
  );
  const droppedSymbols = new Map<string, string>();
  for (const o of outcomes) {
    if (o.kind === "failed") droppedSymbols.set(o.triggerSymbol, o.reason);
  }

  // A buy is dropped only when the *specific* fxLeg that funded it failed.
  // Match by triggering symbol (the trimmer sets `fxLeg.triggeredBySymbol`).
  const droppedForFx = new Set<string>();
  for (const d of trim.decisions) {
    if (d.kind !== "allow" || !d.fxLeg) continue;
    if (failed.has(d.fxLeg.triggeredBySymbol)) droppedForFx.add(d.order.symbol);
  }

  const survivors = originalBuys.filter((b) => !droppedForFx.has(b.symbol));
  return { survivors, droppedSymbols };
}
