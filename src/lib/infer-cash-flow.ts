// Repair cash-flow records whose amount/date cannot be trusted.
//
// A broker CASH_SYNC row reports a deposit as the delta applied to
// `portfolios.starting_cash`. When the sync had no known
// `previousStarting` (the baseline was being repaired rather than
// moved), that delta is a bookkeeping correction, not evidence of how
// much money actually arrived — and it is stamped with the date the
// sync noticed, not the date the equity moved.
//
// Netting such a record verbatim out of the equity series subtracts
// capital the portfolio never received on a day it never received it,
// which turns a flat portfolio into a large fake loss on the card
// (the "-49%" / "-8.9%" sparkline bug).
//
// This helper re-anchors an untrusted inflow onto the largest positive
// step the equity series actually shows, capped at the reported delta.
// Trusted flows (a real before/after cash movement) never go through
// here.

export type FlowPoint = { date: string; amount: number };
export type SeriesPoint = { date: string; value: number };

/**
 * Returns the flow re-anchored to observed equity, or `null` when the
 * series shows no inflow at all (nothing to attribute).
 */
export function reanchorInferredInflow(
  reported: FlowPoint,
  series: SeriesPoint[],
): FlowPoint | null {
  const delta = Number(reported.amount);
  if (!Number.isFinite(delta) || delta <= 0) return null;

  const clean = series
    .filter((p) => p && typeof p.date === "string" && Number.isFinite(Number(p.value)))
    .map((p) => ({ date: p.date, value: Number(p.value) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (clean.length < 2) return reported;

  let bestStep = 0;
  let bestDate = reported.date;
  for (let i = 1; i < clean.length; i++) {
    const step = clean[i].value - clean[i - 1].value;
    if (step > bestStep) {
      bestStep = step;
      bestDate = clean[i].date;
    }
  }

  if (bestStep <= 0) return null;
  // Never claim more capital arrived than the series shows, and never
  // more than the broker reported.
  return { date: bestDate, amount: Math.min(bestStep, delta) };
}

/**
 * A CASH_SYNC row is only trustworthy when it reports a real numeric
 * prior baseline. `null`, `undefined`, empty strings and non-numeric junk
 * all mean "baseline unknown" — and `Number(null) === 0` is finite, so a
 * bare Number.isFinite check would wrongly trust a null row and net a
 * phantom deposit out of the sparkline.
 */
export function trustedPreviousStarting(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
