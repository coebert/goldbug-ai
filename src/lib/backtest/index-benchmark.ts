// Compare thesis-break replay arms against a real market index (default: the
// S&P 500 via SPY) over exactly the same dates the arm was live, instead of a
// synthetic buy-and-hold of the traded universe.
//
// Pure and I/O-free: the caller supplies the index bars.

import type { ArmResult, ReplayBar } from "./thesis-break-replay";

export type IndexSeries = {
  /** Symbol used as the index proxy, e.g. "SPY" or "^GSPC". */
  symbol: string;
  bars: readonly ReplayBar[];
};

export type IndexComparison = {
  arm: string;
  indexSymbol: string;
  from: string;
  to: string;
  days: number;
  armReturnPct: number;
  indexReturnPct: number;
  /** Arm minus index, percentage points. */
  excessReturnPct: number;
  armMaxDrawdownPct: number;
  indexMaxDrawdownPct: number;
  /** Arm drawdown minus index drawdown; positive = arm drew down more. */
  drawdownDeltaPct: number;
  /** Annualised vol of daily returns, %. */
  armVolPct: number;
  indexVolPct: number;
  /** OLS slope of arm daily returns on index daily returns. */
  beta: number;
  /** Annualised alpha vs the index at the estimated beta, %. */
  alphaPct: number;
  correlation: number;
  /** Excess return / tracking error (annualised). */
  informationRatio: number;
  outcome: "beats" | "lags" | "matches";
  summary: string;
};

const TRADING_DAYS = 252;

function maxDrawdownPct(values: readonly number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.min(worst, (v - peak) / peak);
  }
  return Math.abs(worst) * 100;
}

function dailyReturns(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1]!;
    if (prev > 0) out.push(values[i]! / prev - 1);
  }
  return out;
}

function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Align an arm's equity curve with the index on the arm's own dates, carrying
 * the last index close forward across holidays that only one market observes.
 */
export function alignToIndex(
  equity: readonly { date: string; value: number }[],
  index: IndexSeries,
): { dates: string[]; arm: number[]; idx: number[] } {
  const byDate = new Map(index.bars.map((b) => [b.date, b.close]));
  const indexDates = index.bars.map((b) => b.date).sort();
  const dates: string[] = [];
  const arm: number[] = [];
  const idx: number[] = [];
  let cursor = 0;
  let last: number | null = null;
  for (const point of equity) {
    while (cursor < indexDates.length && indexDates[cursor]! <= point.date) {
      last = byDate.get(indexDates[cursor]!) ?? last;
      cursor += 1;
    }
    if (last == null) continue; // index history starts after this bar
    dates.push(point.date);
    arm.push(point.value);
    idx.push(last);
  }
  return { dates, arm, idx };
}

/** Score one replay arm against a real index over the arm's live window. */
export function compareArmToIndex(armResult: ArmResult, index: IndexSeries): IndexComparison | null {
  const { dates, arm, idx } = alignToIndex(armResult.equity, index);
  if (dates.length < 3) return null;

  const armReturnPct = (arm[arm.length - 1]! / arm[0]! - 1) * 100;
  const indexReturnPct = (idx[idx.length - 1]! / idx[0]! - 1) * 100;
  const ra = dailyReturns(arm);
  const ri = dailyReturns(idx);
  const n = Math.min(ra.length, ri.length);
  const a = ra.slice(0, n);
  const b = ri.slice(0, n);

  const sa = stdev(a);
  const sb = stdev(b);
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  for (let i = 0; i < n; i++) cov += (a[i]! - ma) * (b[i]! - mb);
  cov = n > 1 ? cov / (n - 1) : 0;
  const beta = sb > 0 ? cov / (sb * sb) : 0;
  const correlation = sa > 0 && sb > 0 ? cov / (sa * sb) : 0;
  const alphaPct = (ma - beta * mb) * TRADING_DAYS * 100;

  const diff = a.map((x, i) => x - b[i]!);
  const te = stdev(diff) * Math.sqrt(TRADING_DAYS);
  const informationRatio = te > 0 ? (mean(diff) * TRADING_DAYS) / te : 0;

  const excessReturnPct = armReturnPct - indexReturnPct;
  const armMaxDrawdownPct = maxDrawdownPct(arm);
  const indexMaxDrawdownPct = maxDrawdownPct(idx);
  const outcome: IndexComparison["outcome"] =
    Math.abs(excessReturnPct) < 0.25 ? "matches" : excessReturnPct > 0 ? "beats" : "lags";

  const summary =
    `${armResult.arm} returned ${armReturnPct.toFixed(2)}% vs ${index.symbol} ` +
    `${indexReturnPct.toFixed(2)}% (${excessReturnPct >= 0 ? "+" : ""}${excessReturnPct.toFixed(2)}pp, ` +
    `${outcome}); beta ${beta.toFixed(2)}, annualised alpha ${alphaPct >= 0 ? "+" : ""}${alphaPct.toFixed(1)}%, ` +
    `drawdown ${armMaxDrawdownPct.toFixed(2)}% vs ${indexMaxDrawdownPct.toFixed(2)}%.`;

  return {
    arm: armResult.arm,
    indexSymbol: index.symbol,
    from: dates[0]!,
    to: dates[dates.length - 1]!,
    days: dates.length,
    armReturnPct,
    indexReturnPct,
    excessReturnPct,
    armMaxDrawdownPct,
    indexMaxDrawdownPct,
    drawdownDeltaPct: armMaxDrawdownPct - indexMaxDrawdownPct,
    armVolPct: sa * Math.sqrt(TRADING_DAYS) * 100,
    indexVolPct: sb * Math.sqrt(TRADING_DAYS) * 100,
    beta,
    alphaPct,
    correlation,
    informationRatio,
    outcome,
    summary,
  };
}

/** Console table for a set of arm-vs-index comparisons. */
export function indexComparisonReport(rows: readonly IndexComparison[]): string[] {
  if (rows.length === 0) return ["  (no overlapping index history)"];
  const pad = (s: string | number, n: number) => String(s).padStart(n);
  const out: string[] = [];
  const head = rows[0]!;
  out.push(
    `Benchmark: ${head.indexSymbol}  ${head.from} → ${head.to}  (${head.days} shared sessions, ` +
      `index ${head.indexReturnPct.toFixed(2)}%, index MaxDD ${head.indexMaxDrawdownPct.toFixed(2)}%)`,
  );
  out.push(
    [
      pad("Arm", 16),
      pad("Ret%", 8),
      pad("Excess", 8),
      pad("MaxDD%", 8),
      pad("DDdelta", 8),
      pad("Beta", 6),
      pad("Alpha%", 8),
      pad("Corr", 6),
      pad("IR", 6),
      pad("Verdict", 9),
    ].join(" "),
  );
  out.push("-".repeat(90));
  for (const r of rows) {
    out.push(
      [
        pad(r.arm, 16),
        pad(r.armReturnPct.toFixed(2), 8),
        pad((r.excessReturnPct >= 0 ? "+" : "") + r.excessReturnPct.toFixed(2), 8),
        pad(r.armMaxDrawdownPct.toFixed(2), 8),
        pad((r.drawdownDeltaPct >= 0 ? "+" : "") + r.drawdownDeltaPct.toFixed(2), 8),
        pad(r.beta.toFixed(2), 6),
        pad((r.alphaPct >= 0 ? "+" : "") + r.alphaPct.toFixed(1), 8),
        pad(r.correlation.toFixed(2), 6),
        pad(r.informationRatio.toFixed(2), 6),
        pad(r.outcome, 9),
      ].join(" "),
    );
  }
  return out;
}
