// Pure scheduling helpers for the hourly run cycle.
//
// These were extracted from `hourly-run.server.ts` so the ordering + budget
// rules can be simulated in tests without a database or a broker.
//
// Two rules keep every portfolio ticking:
//   1. Ordering — real money first, then STALEST first. A fixed mode ordering
//      let the same portfolio win every cycle and starved the rest.
//   2. Starvation guard — one portfolio that has not produced a decision in
//      STARVED_MS may bypass the run's time budget per cycle, guaranteeing
//      forward progress even when pre-flight eats the whole budget.

export const STARVED_MS = 6 * 60 * 60 * 1000;

export type SchedulablePortfolio = { id: string; mode: string };

/** Real money first, then least-recently-decided first. Returns a new array. */
export function orderPortfoliosForRun<T extends SchedulablePortfolio>(
  portfolios: readonly T[],
  lastDecisionAt: ReadonlyMap<string, number>,
): T[] {
  const priority = (mode: string) => (mode === "live_prod" ? 0 : 1);
  return [...portfolios].sort((a, b) => {
    const dp = priority(String(a.mode)) - priority(String(b.mode));
    if (dp !== 0) return dp;
    return (lastDecisionAt.get(a.id) ?? 0) - (lastDecisionAt.get(b.id) ?? 0);
  });
}

export type BudgetGate = {
  /** True when this portfolio should be skipped for `budget-exceeded`. */
  shouldSkip: (portfolioId: string, elapsedMs: number, nowMs: number) => boolean;
};

/**
 * Budget gate with a one-per-run starvation override.
 *
 * `shouldSkip` consumes the override when it lets a starved portfolio through
 * past the budget, so at most one such bypass happens per cycle.
 */
export function createBudgetGate(
  budgetMs: number,
  lastDecisionAt: ReadonlyMap<string, number>,
  opts: { starvedMs?: number; overrides?: number } = {},
): BudgetGate {
  const starvedMs = opts.starvedMs ?? STARVED_MS;
  let overridesLeft = opts.overrides ?? 1;
  return {
    shouldSkip(portfolioId, elapsedMs, nowMs) {
      if (elapsedMs <= budgetMs) return false;
      const starvedFor = nowMs - (lastDecisionAt.get(portfolioId) ?? 0);
      if (starvedFor > starvedMs && overridesLeft > 0) {
        overridesLeft -= 1;
        return false;
      }
      return true;
    },
  };
}
