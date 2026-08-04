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
  /** `equity_snapshots.source`, when selected — settled vs provisional split. */
  source?: string | null;
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
  /**
   * True when the day's cash flow dwarfs the prior equity base (e.g. a
   * broker cash-sync that re-baselines a £300 pot to £10,300). The
   * residual after netting the flow is basis noise, not trading P&L, so
   * pnl/pct are forced to 0 rather than shown as an implausible swing.
   */
  basisReset: boolean;
};

// A flow this many times larger than the prior equity base means the
// snapshot basis was reset, not that the portfolio traded.
const BASIS_RESET_FLOW_RATIO = 5;

// Even when the flow dwarfs the base, the day is only a basis reset if
// the residual (rawDelta - netFlow) is ALSO implausible for one day of
// trading on the prior base. A documented £999,000 deposit that leaves a
// £5 residual on a £1,000 pot is a real (tiny) trading day, not noise.
const BASIS_RESET_RESIDUAL_RATIO = 0.25;

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
    const residual = rawDelta - netFlow;
    const basisReset =
      netFlow !== 0 &&
      prev.value > 0 &&
      Math.abs(netFlow) / prev.value >= BASIS_RESET_FLOW_RATIO &&
      Math.abs(residual) / prev.value >= BASIS_RESET_RESIDUAL_RATIO;
    const pnl = basisReset ? 0 : residual;
    const pct = !basisReset && prev.value > 0 ? (pnl / prev.value) * 100 : 0;
    out.push({
      date: curr.date,
      prevDate: prev.date,
      prevEquity: prev.value,
      equity: curr.value,
      rawDelta,
      netFlow,
      pnl,
      pct,
      basisReset,
    });
  }
  assertNoFlowLeakage(out, "computeDailyEquityChanges");
  return out;
}

// Absolute tolerance for arithmetic invariants (£/€/$). 1e-6 is well
// below the smallest currency unit; anything larger indicates a real
// leak, not float noise.
const FLOW_LEAK_EPS_ABS = 1e-6;
// Percentage-point tolerance for the derived `pct` reproduction.
const FLOW_LEAK_EPS_PCT = 1e-9;

export type FlowLeakRow = {
  date: string;
  prevEquity: number;
  equity: number;
  rawDelta: number;
  netFlow: number;
  pnl: number;
  pct: number;
  basisReset?: boolean;
};

/**
 * Runtime guard: every daily-equity row MUST satisfy
 *   pnl   = rawDelta - netFlow                  (flow fully netted)
 *   pct   = prev > 0 ? pnl / prev * 100 : 0     (pct derived from pnl only)
 *   pure-flow day (rawDelta ≈ netFlow, netFlow ≠ 0) ⇒ pnl == 0 and pct == 0
 *
 * Throws with an actionable diagnostic on the first offending row so any
 * regression that leaks deposits/withdrawals into daily % change fails
 * loudly in tests and in production logs, not silently on a chart.
 */
export function assertNoFlowLeakage(
  rows: readonly FlowLeakRow[],
  source: string,
  opts: { pctTolerance?: number; absTolerance?: number } = {},
): void {
  const absEps = opts.absTolerance ?? FLOW_LEAK_EPS_ABS;
  const pctEps = opts.pctTolerance ?? FLOW_LEAK_EPS_PCT;
  for (const r of rows) {
    // Basis-reset days (flow ≫ prior equity) intentionally report
    // pnl = pct = 0; the netting identity does not apply to them.
    if (r.basisReset) continue;
    const arithmeticDrift = Math.abs(r.pnl + r.netFlow - r.rawDelta);
    if (arithmeticDrift > absEps) {
      throw new Error(
        `[${source}] flow leak on ${r.date}: pnl(${r.pnl}) + netFlow(${r.netFlow}) ≠ rawDelta(${r.rawDelta}); drift=${arithmeticDrift}`,
      );
    }
    const expectedPct = r.prevEquity > 0 ? (r.pnl / r.prevEquity) * 100 : 0;
    if (Math.abs(r.pct - expectedPct) > pctEps) {
      throw new Error(
        `[${source}] pct drift on ${r.date}: got ${r.pct}%, expected ${expectedPct}% (pnl/prev). pct must derive from pnl only, never rawDelta.`,
      );
    }
    // Pure cash-flow day: rawDelta is entirely explained by netFlow.
    if (
      r.netFlow !== 0 &&
      Math.abs(r.rawDelta - r.netFlow) <= absEps
    ) {
      if (Math.abs(r.pnl) > absEps || Math.abs(r.pct) > pctEps) {
        throw new Error(
          `[${source}] deposit/withdrawal-only day ${r.date} leaked into pnl/pct: pnl=${r.pnl}, pct=${r.pct}%, netFlow=${r.netFlow}`,
        );
      }
    }
  }
}
