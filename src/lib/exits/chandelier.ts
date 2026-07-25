/**
 * Chandelier trailing stop with adaptive tightening.
 *
 * Base stop = highWaterMark * (1 - k_base * atrPct)
 * As unrealised R grows, k shrinks linearly toward k_tight to lock in gains.
 *
 * Pure. No I/O.
 */

export type ChandelierInputs = {
  avgCost: number;
  price: number;
  highWaterMark: number;
  atrPct: number; // e.g. 0.02 = 2% daily ATR
  initialStopAtrMult: number; // used to convert 1R into an ATR-equivalent when no R is set
  kBase: number; // e.g. 3
  kTight: number; // e.g. 1.5
  tightenAfterR: number; // R multiple at which tightening completes (e.g. 2)
};

export type ChandelierResult = {
  stopPrice: number;
  effectiveK: number;
  breached: boolean;
  unrealisedR: number;
  dropFromHwmPct: number;
};

export function evaluateChandelier(i: ChandelierInputs): ChandelierResult {
  const { avgCost, price, highWaterMark, atrPct } = i;
  if (!(avgCost > 0) || !(price > 0) || !(atrPct > 0)) {
    return { stopPrice: 0, effectiveK: i.kBase, breached: false, unrealisedR: 0, dropFromHwmPct: 0 };
  }
  const riskPerShare = avgCost * i.initialStopAtrMult * atrPct;
  const unrealisedR = riskPerShare > 0 ? (highWaterMark - avgCost) / riskPerShare : 0;
  // Linear interp of k from kBase (at 0R) to kTight (at tightenAfterR).
  const t = Math.max(0, Math.min(1, unrealisedR / Math.max(0.01, i.tightenAfterR)));
  const effectiveK = i.kBase + (i.kTight - i.kBase) * t;
  const stopPrice = highWaterMark * (1 - effectiveK * atrPct);
  const breached = price <= stopPrice;
  const dropFromHwmPct = ((price - highWaterMark) / highWaterMark) * 100;
  return { stopPrice, effectiveK, breached, unrealisedR, dropFromHwmPct };
}
