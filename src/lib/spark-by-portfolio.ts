// Extracted so the home-page sparkline mapping can be unit-tested. The rule:
// each portfolio's sparkline uses ONLY that portfolio's own equity snapshots
// (from `perPortfolioSeries`), never the merged multi-portfolio `series`
// axis — which would back-fill starting_cash on other portfolios' snapshot
// dates and produce a fake flat-then-drop curve.

export type SparkPoint = { date: string; value: number };

export type EquityData = {
  portfolios?: Array<{ id: string; mode?: string }>;
  perPortfolioSeries?: Record<string, SparkPoint[]>;
  // Merged axis is intentionally NOT consumed here.
  series?: Array<Record<string, unknown>>;
} | undefined;

export function computeSparkByPortfolio(data: EquityData): Record<string, SparkPoint[]> {
  const map: Record<string, SparkPoint[]> = {};
  const portfolios = data?.portfolios ?? [];
  const own = data?.perPortfolioSeries ?? {};
  for (const p of portfolios) {
    map[p.id] = own[p.id] ?? [];
  }
  return map;
}
