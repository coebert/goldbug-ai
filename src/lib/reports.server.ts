// Server-only helpers for performance reports and cross-portfolio comparisons.
// Kept in a sidecar so `.functions.ts` files can stay thin (see
// tanstack-serverfn-splitting rule).

export type PerfBucket = {
  period_start: string;
  period_end: string;
  label: string;
  strategy_return_pct: number;
  benchmark_return_pct: number | null;
  alpha_pct: number | null;
  volatility_pct: number;
  max_drawdown_pct: number;
  sharpe: number;
  best_day_pct: number;
  worst_day_pct: number;
  days: number;
};

export function isoWeekStart(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

export function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function metricsFromValues(values: number[]) {
  if (values.length < 2) {
    return { returnPct: 0, volPct: 0, sharpe: 0, maxDDPct: 0, bestPct: 0, worstPct: 0 };
  }
  const start = values[0];
  const end = values[values.length - 1];
  const returnPct = start > 0 ? ((end - start) / start) * 100 : 0;
  let peak = values[0];
  let maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? (v - peak) / peak : 0;
    if (dd < maxDD) maxDD = dd;
  }
  const rets: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) rets.push((values[i] - values[i - 1]) / values[i - 1]);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  const volPct = std * Math.sqrt(252) * 100;
  const best = rets.length ? Math.max(...rets) * 100 : 0;
  const worst = rets.length ? Math.min(...rets) * 100 : 0;
  return { returnPct, volPct, sharpe, maxDDPct: maxDD * 100, bestPct: best, worstPct: worst };
}

export function computeMetrics(
  equity: { snapshot_date: string; total_value: number }[],
  startingCash: number,
) {
  if (equity.length === 0) {
    return {
      totalReturnPct: 0,
      maxDrawdownPct: 0,
      sharpe: 0,
      volatilityPct: 0,
      bestDayPct: 0,
      worstDayPct: 0,
      days: 0,
    };
  }
  const values = equity.map((e) => Number(e.total_value));
  const finalValue = values[values.length - 1];
  const totalReturnPct = ((finalValue - startingCash) / startingCash) * 100;

  let peak = values[0];
  let maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  const rets: number[] = [];
  let prev = startingCash;
  for (const v of values) {
    if (prev > 0) rets.push((v - prev) / prev);
    prev = v;
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  const volatilityPct = std * Math.sqrt(252) * 100;
  const best = rets.length ? Math.max(...rets) : 0;
  const worst = rets.length ? Math.min(...rets) : 0;

  return {
    totalReturnPct,
    maxDrawdownPct: maxDD * 100,
    sharpe,
    volatilityPct,
    bestDayPct: best * 100,
    worstDayPct: worst * 100,
    days: values.length,
  };
}
