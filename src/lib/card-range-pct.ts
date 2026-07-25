// Deposit-adjusted range % for a portfolio card's sparkline.
//
// Shared between the home-page PortfolioRow and its tests so the
// "deposits must not masquerade as trading profit" rule stays locked
// in with a component-agnostic contract:
//
//   - Default (includeDeposits = false): cumulative post-baseline
//     deposits are netted out of every subsequent point, so a mid-
//     window cash injection contributes 0% to the card.
//   - Opt-in (includeDeposits = true): raw equity delta is returned,
//     matching the legacy behaviour behind the toggle.
//
// See `buildDepositAdjustedSeries` for the underlying window
// semantics (baseline = first point; deposits dated on or before the
// baseline are already baked in and ignored).

import {
  buildDepositAdjustedSeries,
  type DepositPoint,
  type EquityPoint,
} from "./deposit-adjusted-series";

export type CardSparkPoint = { date: string; value: number };

export function computeCardRangePct(
  sliced: CardSparkPoint[],
  deposits: DepositPoint[],
  includeDeposits: boolean,
): number | null {
  if (sliced.length === 0) return null;
  const points: EquityPoint[] = sliced.map((p) => ({
    date: p.date,
    equity: p.value,
  }));
  const adjusted = buildDepositAdjustedSeries(
    points,
    includeDeposits ? [] : deposits,
  );
  if (adjusted.length === 0) return null;
  return adjusted[adjusted.length - 1].pct;
}
