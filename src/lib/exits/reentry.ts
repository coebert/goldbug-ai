/**
 * Post-stop re-entry lockout.
 *
 * When a symbol is stopped out (any exit type except pure take-profit),
 * block new BUYs on that symbol for `max(baseCooldownDays, atrDaysMult * daysToRecover1ATR)`.
 * A high-vol name gets a longer lockout than a low-vol name for the same
 * cooldown floor, avoiding whipsaw re-entries.
 */

export type ReentryInputs = {
  atrPct: number;
  baseCooldownDays: number;
  atrDaysMult: number;
  minDays: number;
  maxDays: number;
};

export function reentryLockoutDays(i: ReentryInputs): number {
  const atrDays = i.atrPct > 0 ? i.atrDaysMult / i.atrPct : i.baseCooldownDays;
  return Math.max(i.minDays, Math.min(i.maxDays, Math.max(i.baseCooldownDays, Math.ceil(atrDays))));
}
