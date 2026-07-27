// Derive per-day equity % change from equity snapshots, netting out
// deposits/withdrawals so cash flows never masquerade as trading P&L.
//
// For each consecutive snapshot pair (prev → curr):
//   flow  = Σ deposits with date > prev.date AND date <= curr.date
//   pnl   = (curr.total_value - prev.total_value) - flow
//   pct   = prev.total_value > 0 ? (pnl / prev.total_value) * 100 : 0
//
// Same window semantics as computeModeSummary: left-exclusive,
// right-inclusive on the deposit window, so a deposit dated on the
// prev anchor is already baked into prev and NOT re-subtracted.

export type EquitySnapshotLite = {
  snapshot_date: string;
  total_value: number | string;
};

export type DepositLite = {
  date: string;
  amount: number | string;
};

export type DailyEquityChange = {
  date: string;
  prevDate: string;
  prevEquity: number;
  equity: number;
  rawDelta: number;
  netFlow: number;
  pnl: number;
  pct: number;
};

export function computeDailyEquityChanges(
  equity: EquitySnapshotLite[],
  deposits: DepositLite[] = [],
): DailyEquityChange[] {
  const rows = equity
    .map((e) => ({
      date: String(e.snapshot_date),
      value: Number(e.total_value),
    }))
    .filter((r) => r.date && Number.isFinite(r.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 2) return [];

  const cleanDeposits = deposits
    .map((d) => ({ date: String(d.date), amount: Number(d.amount) }))
    .filter((d) => d.date && Number.isFinite(d.amount));

  const out: DailyEquityChange[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];
    let netFlow = 0;
    for (const d of cleanDeposits) {
      if (d.date > prev.date && d.date <= curr.date) netFlow += d.amount;
    }
    const rawDelta = curr.value - prev.value;
    const pnl = rawDelta - netFlow;
    const pct = prev.value > 0 ? (pnl / prev.value) * 100 : 0;
    out.push({
      date: curr.date,
      prevDate: prev.date,
      prevEquity: prev.value,
      equity: curr.value,
      rawDelta,
      netFlow,
      pnl,
      pct,
    });
  }
  return out;
}
