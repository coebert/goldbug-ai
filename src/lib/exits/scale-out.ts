/**
 * R-multiple scale-out ladder.
 *
 * "R" is the initial risk per share, defined at entry as
 *   R = avg_cost * initialStopAtrMult * atrPctAtEntry.
 * When atrPctAtEntry is unknown we approximate with the current atrPct.
 *
 * Levels default to 25% at +1R, 25% at +2R. Remaining 50% is left to run
 * on the chandelier trail.
 *
 * State is derived from prior trades: `levelsAlreadyTaken` counts how many
 * scale-out fills have already fired for this position (0, 1, or 2). The
 * caller supplies it — typically by counting sells since opened_at whose
 * reason begins with "scale-out".
 */

export type ScaleOutLevel = { rMultiple: number; fractionOfPosition: number };

export const DEFAULT_SCALE_OUT_LEVELS: ScaleOutLevel[] = [
  { rMultiple: 1, fractionOfPosition: 0.25 },
  { rMultiple: 2, fractionOfPosition: 0.25 },
];

export type ScaleOutInputs = {
  avgCost: number;
  price: number;
  atrPct: number;
  initialStopAtrMult: number;
  levels: ScaleOutLevel[];
  levelsAlreadyTaken: number;
};

export type ScaleOutResult = {
  fire: boolean;
  levelIndex: number | null;
  sellFraction: number;
  rMultipleReached: number;
  reason: string | null;
};

export function evaluateScaleOut(i: ScaleOutInputs): ScaleOutResult {
  const { avgCost, price, atrPct, initialStopAtrMult, levels, levelsAlreadyTaken } = i;
  if (!(avgCost > 0) || !(price > 0) || !(atrPct > 0) || levels.length === 0) {
    return { fire: false, levelIndex: null, sellFraction: 0, rMultipleReached: 0, reason: null };
  }
  const riskPerShare = avgCost * initialStopAtrMult * atrPct;
  if (!(riskPerShare > 0)) {
    return { fire: false, levelIndex: null, sellFraction: 0, rMultipleReached: 0, reason: null };
  }
  const rReached = (price - avgCost) / riskPerShare;
  // Fire only the *next* untaken level whose R has been reached.
  const nextIdx = levelsAlreadyTaken;
  if (nextIdx >= levels.length) {
    return { fire: false, levelIndex: null, sellFraction: 0, rMultipleReached: rReached, reason: null };
  }
  const level = levels[nextIdx];
  if (rReached >= level.rMultiple) {
    return {
      fire: true,
      levelIndex: nextIdx,
      sellFraction: level.fractionOfPosition,
      rMultipleReached: rReached,
      reason: `scale-out L${nextIdx + 1} @ ${rReached.toFixed(2)}R (target ${level.rMultiple}R, sell ${(level.fractionOfPosition * 100).toFixed(0)}%)`,
    };
  }
  return { fire: false, levelIndex: null, sellFraction: 0, rMultipleReached: rReached, reason: null };
}
