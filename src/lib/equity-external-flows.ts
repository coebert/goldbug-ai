// Detection and netting of external cash flows in the equity snapshot series.
//
// Why this exists: hard risk halts compare current equity against the
// all-time peak snapshot. That comparison is only meaningful if every point
// in the series is measured on the same capital base. A deposit inflates the
// peak forever; a withdrawal then reads as a catastrophic "drawdown" and
// blocks every BUY indefinitely — a trading outage caused purely by
// bookkeeping.
//
// A day is treated as an external flow when the move is essentially all on
// the cash line and far too large to be a trading result:
//   • |Δcash| is at least `MIN_FLOW_SHARE` of the prior day's equity, and
//   • the holdings line barely moved (|Δholdings| <= `MAX_HOLDINGS_NOISE` of
//     |Δcash|) — a buy or sell moves cash and holdings in opposite directions
//     by nearly the same amount, so it can never satisfy this.
//
// Recorded fund events (sim deposits) are merged in as known flows so we do
// not depend on detection alone.
//
// Pure module: no I/O, so the classification rules are unit-testable.

export type EquityPoint = {
  date: string;            // ISO snapshot date, ascending order not required
  totalValue: number;
  cash: number;
  holdingsValue: number;
};

export type ExternalFlow = {
  date: string;            // date the flow landed on
  amount: number;          // signed: + deposit, − withdrawal
  source: "recorded" | "detected";
};

/** A step must move at least this share of prior equity to count as a flow. */
export const MIN_FLOW_SHARE = 0.15;
/** ...and at least this absolute amount, so tiny books aren't over-flagged. */
export const MIN_FLOW_ABS = 500;
/** Holdings may drift by this share of the cash move and still count as pure cash. */
export const MAX_HOLDINGS_NOISE = 0.05;

function asc(points: EquityPoint[]): EquityPoint[] {
  return [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Classifies day-over-day steps that look like deposits/withdrawals rather
 * than trading results.
 */
export function detectExternalFlows(points: EquityPoint[]): ExternalFlow[] {
  const rows = asc(points);
  const flows: ExternalFlow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const dCash = cur.cash - prev.cash;
    const dHold = cur.holdingsValue - prev.holdingsValue;
    const prior = Math.abs(prev.totalValue);
    if (!Number.isFinite(dCash) || !Number.isFinite(dHold)) continue;
    const threshold = Math.max(prior * MIN_FLOW_SHARE, MIN_FLOW_ABS);
    if (Math.abs(dCash) < threshold) continue;
    if (Math.abs(dHold) > Math.abs(dCash) * MAX_HOLDINGS_NOISE) continue;
    flows.push({ date: cur.date, amount: dCash, source: "detected" });
  }
  return flows;
}

/**
 * Merges recorded fund events with detected steps, preferring the recorded
 * amount when both describe the same date (avoids double-counting a deposit
 * that detection also spotted).
 */
export function mergeFlows(
  recorded: ExternalFlow[],
  detected: ExternalFlow[],
): ExternalFlow[] {
  const byDate = new Map<string, ExternalFlow>();
  for (const f of detected) byDate.set(f.date, f);
  for (const f of recorded) byDate.set(f.date, { ...f, source: "recorded" });
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Restates every historical point onto today's capital base by adding the
 * net flows that landed *after* that point. A past peak recorded before a
 * large withdrawal is therefore compared like-for-like against current
 * equity, and pure bookkeeping can no longer manufacture a drawdown.
 */
export function flowAdjustedSeries(
  points: EquityPoint[],
  flows: ExternalFlow[],
): Array<{ date: string; adjusted: number; raw: number }> {
  const rows = asc(points);
  const sorted = [...flows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const total = sorted.reduce((s, f) => s + f.amount, 0);
  let seen = 0;
  let fi = 0;
  const out: Array<{ date: string; adjusted: number; raw: number }> = [];
  for (const p of rows) {
    while (fi < sorted.length && sorted[fi].date <= p.date) {
      seen += sorted[fi].amount;
      fi++;
    }
    // flows strictly after this point
    out.push({ date: p.date, adjusted: p.totalValue + (total - seen), raw: p.totalValue });
  }
  return out;
}

/**
 * Peak equity on a flow-adjusted basis, plus the prior close (also adjusted)
 * relative to `asOf`.
 */
export function flowAdjustedStats(
  points: EquityPoint[],
  flows: ExternalFlow[],
  asOf: string,
): { peakEquity: number | null; priorCloseEquity: number | null; netFlow: number } {
  const series = flowAdjustedSeries(points, flows);
  if (series.length === 0) {
    return { peakEquity: null, priorCloseEquity: null, netFlow: 0 };
  }
  const peak = series.reduce((m, r) => Math.max(m, r.adjusted), 0);
  const before = series.filter((r) => r.date < asOf);
  const prior = before.length ? before[before.length - 1].adjusted : null;
  return {
    peakEquity: peak > 0 ? peak : null,
    priorCloseEquity: prior,
    netFlow: flows.reduce((s, f) => s + f.amount, 0),
  };
}
