// Compute per-mode (real/sim) equity summary for the dashboard tile,
// EXCLUDING external cash deposits from the pnl / percent change so a
// deposit doesn't masquerade as a trading gain.
//
// Inputs:
//   - series: the merged equity series from buildAllPortfoliosEquity
//     (rows keyed by date, with per-portfolio-id total_value columns)
//   - portfolios: the portfolio metadata (id + mode)
//   - deposits: external cash-flow events. Positive = deposit,
//     negative = withdrawal. Each event has a date (YYYY-MM-DD) and
//     the portfolio it belongs to.
//
// Output per mode: { now, pnl, pct, count } where
//   pnl = (now − previous) − netDepositsBetweenPrevExclusiveAndLastInclusive
//   pct = pnl / max(previous, 0) * 100    (0 when previous <= 0)
//
// Rationale: netting deposits out of both the numerator (delta) and
// leaving the denominator anchored to the pre-deposit equity produces
// the same number as trading-only PnL over the window. A £200
// deposit that arrives between two snapshots therefore contributes 0
// to pnl and 0 to pct — matching the user's stated intent that
// "deposits should not give a false impression of profits".

export type SummaryPortfolio = {
  id: string;
  mode?: string | null;
};

export type SummarySeriesRow = Record<string, unknown> & { date: string };

import { capitalAdjustedPct } from "./capital-adjusted-return";


export type DepositEvent = {
  portfolio_id: string;
  /** YYYY-MM-DD */
  date: string;
  /** Positive = deposit into the account, negative = withdrawal. */
  amount: number;
};

export type ModeSummary = {
  now: number;
  pnl: number;
  pct: number;
  count: number;
};

export type ModeSummaryPair = {
  sim: ModeSummary;
  real: ModeSummary;
} | null;

export type ComputeModeSummaryOptions = {
  /**
   * When true, deposits are NOT netted out of pnl/pct — the summary
   * reflects raw equity change including cash-flows. Default false.
   * The default (false) matches the user's stated intent that
   * deposits must not masquerade as trading profit.
   */
  includeDeposits?: boolean;
};

export function computeModeSummary(
  series: SummarySeriesRow[],
  portfolios: SummaryPortfolio[],
  deposits: DepositEvent[] = [],
  options: ComputeModeSummaryOptions = {},
): ModeSummaryPair {
  if (series.length === 0 || portfolios.length === 0) return null;
  const includeDeposits = options.includeDeposits === true;

  const isRealPortfolio = (p: SummaryPortfolio) => p.mode === "live_prod";
  const idsByMode = (real: boolean) =>
    new Set(portfolios.filter((p) => isRealPortfolio(p) === real).map((p) => p.id));

  const hasModeValue = (row: SummarySeriesRow, real: boolean) =>
    portfolios.some((p) => {
      if (isRealPortfolio(p) !== real) return false;
      return Number.isFinite(Number(row[p.id]));
    });
  const sumMode = (row: SummarySeriesRow, real: boolean) =>
    portfolios.reduce((sum, p) => {
      if (isRealPortfolio(p) !== real) return sum;
      const v = Number(row[p.id]);
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);

  const modeSummary = (real: boolean): ModeSummary => {
    const rows = series.filter((r) => hasModeValue(r, real));
    const last = rows[rows.length - 1];
    const count = portfolios.filter((p) => isRealPortfolio(p) === real).length;
    if (!last) return { now: 0, pnl: 0, pct: 0, count };
    const prev = rows.length > 1 ? rows[rows.length - 2] : last;
    const now = sumMode(last, real);
    const previous = sumMode(prev, real);

    // Net deposits attributable to THIS mode's portfolios, occurring
    // AFTER the previous snapshot date and up to & including the last
    // snapshot date. Deposits dated on/before `prev.date` are already
    // baked into `previous`, so excluding them there would double-
    // count. Same-portfolio-same-day: use string comparison — dates
    // are ISO YYYY-MM-DD and lexicographically ordered.
    const ids = idsByMode(real);
    const prevDate = prev.date;
    const lastDate = last.date;
    let netDeposits = 0;
    for (const d of deposits) {
      if (!ids.has(d.portfolio_id)) continue;
      if (rows.length > 1) {
        // Strictly after prevDate, up to & including lastDate.
        if (d.date <= prevDate) continue;
        if (d.date > lastDate) continue;
      } else {
        // Only one data point exists — nothing to compare against, so
        // no deposit adjustment applies.
        continue;
      }
      const amt = Number(d.amount);
      if (Number.isFinite(amt)) netDeposits += amt;
    }

    const rawDelta = now - previous;
    const pnl = includeDeposits ? rawDelta : rawDelta - netDeposits;
    // Delegate to the shared capital-adjusted helper so every equity %
    // surface in the app uses the same denominator contract. See
    // src/lib/capital-adjusted-return.ts for the invariants.
    const pct = includeDeposits
      ? (previous > 0 ? (pnl / previous) * 100 : 0)
      : capitalAdjustedPct({ pnl, baseline: previous, netFlow: netDeposits });
    return { now, pnl, pct, count };

  };

  return {
    sim: modeSummary(false),
    real: modeSummary(true),
  };
}
