/**
 * ATR-scaled hard stop.
 *
 * The fixed `stop_loss_pct` treats a 1%-ATR mega-cap and a 6%-ATR miner the
 * same way. That is what let AAPL run 10.9% against the book before the
 * mechanical layer fired, even though 10.9% was ~7 daily ATRs for that name.
 *
 * Effective stop = clamp(k * atrPct, floorPct, fixed stop_loss_pct)
 *
 *  - Quiet, gappy mega-caps get a *tighter* stop automatically.
 *  - Genuinely volatile names never get a *wider* stop than the configured
 *    fixed stop, so the risk budget can only shrink, never grow.
 *  - The floor stops intraday noise from knocking positions out.
 *
 * Pure. No I/O.
 */

export type AtrScaledStopInputs = {
  /** Configured fixed stop as a fraction (e.g. 0.10 = 10%). 0 disables stops. */
  fixedStopPct: number;
  /** Daily ATR as a fraction of price (e.g. 0.015 = 1.5%). 0/unknown = no scaling. */
  atrPct: number;
  /** ATR multiple defining 1R of initial risk (cfg.initial_stop_atr_mult). */
  atrMult: number;
  /** Lower bound so noise can't trigger the stop (fraction, e.g. 0.03). */
  floorPct: number;
  /** Feature switch — false returns the fixed stop unchanged. */
  enabled: boolean;
};

export type AtrScaledStopResult = {
  /** Stop fraction actually applied (0 when stops are disabled). */
  effectiveStopPct: number;
  /** True when the ATR layer tightened the fixed stop. */
  scaled: boolean;
  /** Raw k*ATR value before clamping, for logging/explanations. */
  rawAtrStopPct: number;
  /** Human-readable note for audit rows and run explanations. */
  note: string;
};

export function atrScaledStopPct(i: AtrScaledStopInputs): AtrScaledStopResult {
  const fixed = Number.isFinite(i.fixedStopPct) ? Math.max(0, i.fixedStopPct) : 0;
  if (fixed <= 0) {
    return { effectiveStopPct: 0, scaled: false, rawAtrStopPct: 0, note: "no stop-loss configured" };
  }
  const atrPct = Number.isFinite(i.atrPct) ? Math.max(0, i.atrPct) : 0;
  const mult = Number.isFinite(i.atrMult) ? Math.max(0, i.atrMult) : 0;
  if (!i.enabled || !(atrPct > 0) || !(mult > 0)) {
    return {
      effectiveStopPct: fixed,
      scaled: false,
      rawAtrStopPct: 0,
      note: `fixed stop ${(fixed * 100).toFixed(1)}%`,
    };
  }

  const raw = mult * atrPct;
  const floor = Math.max(0, Math.min(fixed, Number.isFinite(i.floorPct) ? Math.max(0, i.floorPct) : 0));
  const effective = Math.min(fixed, Math.max(floor, raw));
  const scaled = effective < fixed - 1e-12;
  return {
    effectiveStopPct: effective,
    scaled,
    rawAtrStopPct: raw,
    note: scaled
      ? `ATR-scaled stop ${(effective * 100).toFixed(2)}% (${mult}×ATR ${(atrPct * 100).toFixed(2)}%, floor ${(floor * 100).toFixed(1)}%, fixed cap ${(fixed * 100).toFixed(1)}%)`
      : `fixed stop ${(fixed * 100).toFixed(1)}% (ATR stop ${(raw * 100).toFixed(2)}% not tighter)`,
  };
}
