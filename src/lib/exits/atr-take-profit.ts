/**
 * ATR-scaled take-profit.
 *
 * A single fixed take-profit percentage is the mirror image of the fixed-stop
 * problem: +25% is roughly 4 daily ATRs for a quiet mega-cap (so it never
 * fires and gains round-trip) and less than 1 ATR for a volatile miner (so it
 * fires on noise and caps the winners we actually need). Sizing the target in
 * ATRs keeps every position aiming at the same *risk-adjusted* payoff.
 *
 * Effective target = clamp(k * atrPct, floorPct, capPct)
 *
 *  - `enabled: false` (or no usable ATR) falls back to the configured fixed
 *    take-profit, so behaviour is unchanged when the layer is switched off.
 *  - `takeProfitEnabled: false`, or a fixed target of 0 with no ATR target,
 *    means no take-profit at all: the position is managed purely by the stop,
 *    trail and time layers. Take-profit is optional by design — letting
 *    winners run is often the right call in a strong trend.
 *
 * Pure. No I/O.
 */

export type AtrTakeProfitInputs = {
  /** Master switch. False = no take-profit leg at all. */
  takeProfitEnabled: boolean;
  /** Configured fixed take-profit as a fraction (e.g. 0.25 = +25%). */
  fixedTakeProfitPct: number;
  /** Daily ATR as a fraction of price (e.g. 0.015 = 1.5%). 0/unknown = no scaling. */
  atrPct: number;
  /** ATR multiple defining the profit target (e.g. 4 = 4×ATR). */
  atrMult: number;
  /** Lower bound so a target can't sit inside normal daily noise. */
  floorPct: number;
  /** Upper bound so a wild ATR can't push the target out of reach. */
  capPct: number;
  /** Feature switch for the ATR scaling itself. */
  atrScalingEnabled: boolean;
};

export type AtrTakeProfitResult = {
  /** Target fraction actually applied. 0 means "no take-profit". */
  effectiveTakeProfitPct: number;
  /** True when the ATR layer set the target (rather than the fixed value). */
  scaled: boolean;
  /** Raw k*ATR value before clamping, for logging/explanations. */
  rawAtrTakeProfitPct: number;
  /** Human-readable note for audit rows and run explanations. */
  note: string;
};

export function atrTakeProfitPct(i: AtrTakeProfitInputs): AtrTakeProfitResult {
  const fixed = Number.isFinite(i.fixedTakeProfitPct) ? Math.max(0, i.fixedTakeProfitPct) : 0;

  if (!i.takeProfitEnabled) {
    return {
      effectiveTakeProfitPct: 0,
      scaled: false,
      rawAtrTakeProfitPct: 0,
      note: "take-profit disabled — winners run until a stop, trail or time exit",
    };
  }

  const atrPct = Number.isFinite(i.atrPct) ? Math.max(0, i.atrPct) : 0;
  const mult = Number.isFinite(i.atrMult) ? Math.max(0, i.atrMult) : 0;

  if (!i.atrScalingEnabled || !(atrPct > 0) || !(mult > 0)) {
    return {
      effectiveTakeProfitPct: fixed,
      scaled: false,
      rawAtrTakeProfitPct: 0,
      note: fixed > 0
        ? `fixed take-profit ${(fixed * 100).toFixed(1)}%`
        : "no take-profit configured",
    };
  }

  const raw = mult * atrPct;
  const floor = Number.isFinite(i.floorPct) ? Math.max(0, i.floorPct) : 0;
  const capRaw = Number.isFinite(i.capPct) ? Math.max(0, i.capPct) : 0;
  const cap = capRaw > 0 ? Math.max(floor, capRaw) : Infinity;
  const effective = Math.min(cap, Math.max(floor, raw));

  return {
    effectiveTakeProfitPct: effective,
    scaled: true,
    rawAtrTakeProfitPct: raw,
    note: `ATR take-profit ${(effective * 100).toFixed(2)}% (${mult}×ATR ${(atrPct * 100).toFixed(2)}%${
      effective > raw + 1e-12 ? `, raised to floor ${(floor * 100).toFixed(1)}%` : ""
    }${effective < raw - 1e-12 ? `, capped at ${(cap * 100).toFixed(1)}%` : ""})`,
  };
}

/**
 * Convenience: the price level a long position exits at, given cost basis and
 * the effective target. Returns null when no take-profit applies.
 */
export function takeProfitPrice(avgCost: number, effectiveTakeProfitPct: number): number | null {
  if (!(avgCost > 0) || !(effectiveTakeProfitPct > 0)) return null;
  return avgCost * (1 + effectiveTakeProfitPct);
}

/** Companion helper: the price level an ATR-scaled hard stop exits at. */
export function stopLossPrice(avgCost: number, effectiveStopPct: number): number | null {
  if (!(avgCost > 0) || !(effectiveStopPct > 0)) return null;
  return avgCost * (1 - effectiveStopPct);
}
