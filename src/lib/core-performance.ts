export type PricePoint = { date: string; close: number };

export type PerformanceMetrics = {
  startDate: string;
  endDate: string;
  observations: number;
  startPrice: number;
  latestPrice: number;
  high: number;
  low: number;
  totalReturn: number;
  annualisedReturn: number;
  annualisedVolatility: number;
  maxDrawdown: number;
};

export type FundPerformance = {
  symbol: string;
  name: string;
  currency: string;
  series: PricePoint[];
  metrics: PerformanceMetrics | null;
  targetAllocationReturn: number | null;
};

export function cleanPriceSeries(points: readonly PricePoint[]): PricePoint[] {
  const byDate = new Map<string, number>();
  for (const point of points) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.close) && point.close > 0) {
      byDate.set(point.date, point.close);
    }
  }
  return [...byDate].map(([date, close]) => ({ date, close })).sort((a, b) => a.date.localeCompare(b.date));
}

export function calculatePerformance(points: readonly PricePoint[]): PerformanceMetrics | null {
  const series = cleanPriceSeries(points);
  if (series.length < 2) return null;
  const first = series[0];
  const last = series[series.length - 1];
  const totalReturn = last.close / first.close - 1;
  const elapsedDays = Math.max(1, (Date.parse(last.date) - Date.parse(first.date)) / 86_400_000);
  const years = elapsedDays / 365.25;
  const annualisedReturn = Math.pow(last.close / first.close, 1 / years) - 1;
  const dailyReturns: number[] = [];
  let peak = first.close;
  let maxDrawdown = 0;
  for (let i = 0; i < series.length; i += 1) {
    const value = series[i].close;
    peak = Math.max(peak, value);
    maxDrawdown = Math.min(maxDrawdown, value / peak - 1);
    if (i > 0) dailyReturns.push(value / series[i - 1].close - 1);
  }
  const mean = dailyReturns.reduce((sum, value) => sum + value, 0) / Math.max(1, dailyReturns.length);
  const variance = dailyReturns.length > 1
    ? dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (dailyReturns.length - 1)
    : 0;
  return {
    startDate: first.date,
    endDate: last.date,
    observations: series.length,
    startPrice: first.close,
    latestPrice: last.close,
    high: Math.max(...series.map((point) => point.close)),
    low: Math.min(...series.map((point) => point.close)),
    totalReturn,
    annualisedReturn,
    annualisedVolatility: Math.sqrt(variance) * Math.sqrt(252),
    maxDrawdown,
  };
}

export function normalizeReturns(points: readonly PricePoint[]): Array<{ date: string; returnPct: number }> {
  const series = cleanPriceSeries(points);
  const start = series[0]?.close;
  if (!start) return [];
  return series.map((point) => ({ date: point.date, returnPct: (point.close / start - 1) * 100 }));
}

export function targetAllocationReturn(fundReturn: number, targetPct: number): number {
  if (!Number.isFinite(fundReturn) || !Number.isFinite(targetPct)) return 0;
  return fundReturn * Math.max(0, Math.min(1, targetPct));
}

export function mergeNormalisedSeries(
  funds: readonly Pick<FundPerformance, "symbol" | "series">[],
): Array<Record<string, string | number>> {
  const rows = new Map<string, Record<string, string | number>>();
  for (const fund of funds) {
    for (const point of normalizeReturns(fund.series)) {
      const row = rows.get(point.date) ?? { date: point.date };
      row[fund.symbol] = point.returnPct;
      rows.set(point.date, row);
    }
  }
  return [...rows.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}
