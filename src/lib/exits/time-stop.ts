/**
 * Horizon-tied time stop.
 *
 * If the position has been open for at least `horizonDays` and unrealised
 * R is below `minProgressR`, exit — the thesis's expected window has
 * elapsed without meaningful follow-through. Distinct from the existing
 * max_hold_days hard time cap: this is *conditional* on lack of progress.
 */

export type TimeStopInputs = {
  avgCost: number;
  price: number;
  atrPct: number;
  initialStopAtrMult: number;
  openedAtMs: number;
  nowMs: number;
  horizonDays: number;
  minProgressR: number;
};

export type TimeStopResult = {
  triggered: boolean;
  heldDays: number;
  rReached: number;
  reason: string | null;
};

export function evaluateTimeStop(i: TimeStopInputs): TimeStopResult {
  const { avgCost, price, atrPct, initialStopAtrMult, openedAtMs, nowMs, horizonDays, minProgressR } = i;
  const heldDays = Math.floor(Math.max(0, nowMs - openedAtMs) / 86_400_000);
  if (!(avgCost > 0) || !(price > 0) || !(atrPct > 0) || horizonDays <= 0) {
    return { triggered: false, heldDays, rReached: 0, reason: null };
  }
  if (heldDays < horizonDays) {
    return { triggered: false, heldDays, rReached: 0, reason: null };
  }
  const riskPerShare = avgCost * initialStopAtrMult * atrPct;
  const rReached = riskPerShare > 0 ? (price - avgCost) / riskPerShare : 0;
  if (rReached < minProgressR) {
    return {
      triggered: true,
      heldDays,
      rReached,
      reason: `time-stop: ${heldDays}d ≥ ${horizonDays}d horizon with only ${rReached.toFixed(2)}R (min ${minProgressR}R)`,
    };
  }
  return { triggered: false, heldDays, rReached, reason: null };
}
