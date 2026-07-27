// Shared helper: net external deposits/withdrawals out of an equity
// series so % changes reflect trading PnL only. Same window semantics
// as computeModeSummary (mode-summary.ts):
//   - deposits with date <= startDate are baked into the baseline and
//     are NOT subtracted (they already sit inside the starting equity)
//   - deposits with date > startDate contribute to a running cumulative
//     total that is subtracted from every point on or after their date
//
// The helper produces, per point:
//   equity   — raw stored equity for that date (unchanged)
//   adjusted — equity minus cumulative post-start deposits
//   pct      — (adjusted − baseline) / baseline * 100, 0 when baseline <= 0
//   deposit  — net deposit amount applied at that date (0 elsewhere)
//
// When the deposit list is empty the helper is a pure pass-through:
// `adjusted === equity` and `pct === raw%`.

export type EquityPoint = { date: string; equity: number };
export type DepositPoint = { date: string; amount: number };

export type AdjustedPoint = {
  date: string;
  equity: number;
  adjusted: number;
  pct: number;
  deposit: number;
};

export function buildDepositAdjustedSeries(
  points: EquityPoint[],
  deposits: DepositPoint[],
  startDateOverride?: string,
): AdjustedPoint[] {
  if (points.length === 0) return [];
  const startDate = startDateOverride ?? points[0].date;
  const baseline = Number(points[0].equity);

  // Collect deposits strictly after startDate and sort ascending so
  // we can sweep them into the cumulative total as each point date
  // passes. This matches computeModeSummary, which counts every
  // deposit in the window regardless of whether its date lines up
  // with a stored equity snapshot.
  const relevant = deposits
    .filter((d) => {
      if (!d || d.date <= startDate) return false;
      const amt = Number(d.amount);
      return Number.isFinite(amt);
    })
    .map((d) => ({ date: d.date, amount: Number(d.amount) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let cumulative = 0;
  let depIdx = 0;
  const out: AdjustedPoint[] = [];
  for (const p of points) {
    const equity = Number(p.equity);
    // Absorb every not-yet-applied deposit dated on/before this
    // point. Deposits landing between two stored snapshots are
    // still fully accounted for at the next snapshot.
    let dep = 0;
    while (depIdx < relevant.length && relevant[depIdx].date <= p.date) {
      dep += relevant[depIdx].amount;
      depIdx += 1;
    }
    cumulative += dep;
    const adjusted = equity - cumulative;
    // Denominator scales with cumulative net flows so a large mid-
    // window deposit does not divide subsequent trading PnL by the
    // tiny pre-deposit baseline (which would produce a ridiculous %
    // like +1101% for a £999k top-up that only earned +£11k trading).
    // This is equivalent to a capital-adjusted return / single-flow
    // TWRR: (equity − cumFlows − baseline) / (baseline + cumFlows).
    // Capital-adjusted denom = baseline + cumulative flows. If a large
    // withdrawal collapses the denom to <= 0, fall back to `baseline`
    // so pct stays finite — matches computeModeSummary's guard.
    const denomRaw = baseline + cumulative;
    const denomSafe = denomRaw > 0 ? denomRaw : baseline;
    const pct =
      Number.isFinite(baseline) && baseline > 0 && denomSafe > 0
        ? ((adjusted - baseline) / denomSafe) * 100
        : 0;


    out.push({
      date: p.date,
      equity: Number.isFinite(equity) ? equity : 0,
      adjusted: Number.isFinite(adjusted) ? adjusted : 0,
      pct: Number.isFinite(pct) ? pct : 0,
      deposit: dep,
    });
  }
  return out;

}


// Convenience: last-point % vs baseline, deposit-adjusted.
export function trailingAdjustedPct(
  points: EquityPoint[],
  deposits: DepositPoint[],
): number {
  const s = buildDepositAdjustedSeries(points, deposits);
  return s.length === 0 ? 0 : s[s.length - 1].pct;
}
