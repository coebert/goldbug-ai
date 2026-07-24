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

  // Bucket deposits by date (strictly after startDate). Non-finite
  // amounts are silently dropped; unknown dates are still bucketed
  // because the caller filtered by portfolio already.
  const byDate = new Map<string, number>();
  for (const d of deposits) {
    if (!d || d.date <= startDate) continue;
    const amt = Number(d.amount);
    if (!Number.isFinite(amt)) continue;
    byDate.set(d.date, (byDate.get(d.date) ?? 0) + amt);
  }

  let cumulative = 0;
  const out: AdjustedPoint[] = [];
  for (const p of points) {
    const equity = Number(p.equity);
    const dep = byDate.get(p.date) ?? 0;
    cumulative += dep;
    const adjusted = equity - cumulative;
    const pct =
      Number.isFinite(baseline) && baseline > 0
        ? ((adjusted - baseline) / baseline) * 100
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
