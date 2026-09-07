import type { HoldingSeries } from "@/lib/holdings-history.functions";

export type HoldingEquityChartRow = {
  at: string;
  [symbol: string]: string | number | null;
};

export function buildHoldingEquityChangeRows(series: HoldingSeries[]): {
  rows: HoldingEquityChartRow[];
  symbols: string[];
} {
  const eligible = series.filter(
    (holding) =>
      Number.isFinite(holding.avg_cost) &&
      holding.avg_cost > 0 &&
      holding.closes.length > 0 &&
      holding.dailyAt.length === holding.closes.length,
  );
  const symbols = eligible.map((holding) => holding.symbol);
  const byTime = new Map<string, HoldingEquityChartRow>();

  for (const holding of eligible) {
    holding.dailyAt.forEach((at, index) => {
      const price = holding.closes[index];
      if (!at || !Number.isFinite(price) || price <= 0) return;
      const key = String(at);
      const row = byTime.get(key) ?? { at: key };
      row[holding.symbol] = Number((((price / holding.avg_cost) - 1) * 100).toFixed(8));
      byTime.set(key, row);
    });
  }

  return {
    rows: [...byTime.values()].sort((a, b) => a.at.localeCompare(b.at)),
    symbols,
  };
}