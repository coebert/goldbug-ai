export type PortfolioEquityInput = {
  id: string;
  name: string;
  currency: string;
  mode: string | null;
  starting_cash: number | string | null;
  current_cash: number | string | null;
};

export type EquitySnapshotInput = {
  portfolio_id: string;
  snapshot_date: string;
  total_value: number | string | null;
};

export type PortfolioEquityPoint = { date: string; value: number };

export type AllPortfoliosEquity = {
  portfolios: Array<{ id: string; name: string; currency: string; mode: string }>;
  series: Array<Record<string, string | number>>;
  perPortfolioSeries: Record<string, PortfolioEquityPoint[]>;
  currency: string;
  /** True when >1 distinct portfolio currency is present. Series totals
   *  (`total_sim`, `total_real`) are only meaningful when every portfolio
   *  reports the same currency; the UI must show a warning otherwise. */
  mixedCurrency: boolean;
  /** Distinct currencies observed across the portfolio list. */
  currencies: string[];
};

function toNumber(value: number | string | null | undefined, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function latestValueOnOrBefore(series: PortfolioEquityPoint[], date: string) {
  if (series.length === 0 || date < series[0].date) return undefined;
  let value: number | undefined;
  for (const point of series) {
    if (point.date <= date) value = point.value;
    else break;
  }
  return value;
}

export function buildAllPortfoliosEquity({
  portfolios,
  snapshots,
  today,
}: {
  portfolios: PortfolioEquityInput[];
  snapshots: EquitySnapshotInput[];
  today: string;
}): AllPortfoliosEquity {
  const list = portfolios;
  const distinctCurrencies = Array.from(
    new Set(list.map((p) => (p.currency || "GBP").toUpperCase())),
  ).sort();
  const mixedCurrency = distinctCurrencies.length > 1;
  if (list.length === 0) {
    return {
      portfolios: [],
      series: [],
      perPortfolioSeries: {},
      currency: "GBP",
      mixedCurrency: false,
      currencies: [],
    };
  }

  const byPortfolio = new Map<string, PortfolioEquityPoint[]>();
  for (const snapshot of snapshots) {
    const value = toNumber(snapshot.total_value, Number.NaN);
    if (!Number.isFinite(value)) continue;
    const arr = byPortfolio.get(snapshot.portfolio_id) ?? [];
    arr.push({ date: snapshot.snapshot_date, value });
    byPortfolio.set(snapshot.portfolio_id, arr);
  }

  for (const arr of byPortfolio.values()) {
    arr.sort((a, b) => a.date.localeCompare(b.date));
  }

  const perPortfolio = list.map((portfolio) => ({
    id: portfolio.id,
    name: portfolio.name,
    currency: portfolio.currency,
    mode: portfolio.mode ?? "paper",
    starting_cash: toNumber(portfolio.starting_cash),
    current_cash: toNumber(portfolio.current_cash),
    series: byPortfolio.get(portfolio.id) ?? [],
  }));

  const dates = new Set<string>();
  for (const portfolio of perPortfolio) {
    if (portfolio.series.length === 0) dates.add(today);
    else for (const point of portfolio.series) dates.add(point.date);
  }

  const sortedDates = [...dates].sort();
  const isReal = (mode: string) => mode === "live_prod";

  const series = sortedDates.map((date) => {
    let totalSim = 0;
    let totalReal = 0;
    let hasSim = false;
    let hasReal = false;
    const row: Record<string, string | number> = { date };

    for (const portfolio of perPortfolio) {
      const value = portfolio.series.length === 0
        ? date === today
          ? portfolio.current_cash
          : undefined
        : latestValueOnOrBefore(portfolio.series, date);

      if (value == null || !Number.isFinite(value)) continue;

      row[portfolio.id] = value;
      if (isReal(portfolio.mode)) {
        totalReal += value;
        hasReal = true;
      } else {
        totalSim += value;
        hasSim = true;
      }
    }

    if (hasSim) row.total_sim = totalSim;
    if (hasReal) row.total_real = totalReal;
    return row;
  });

  const perPortfolioSeries: Record<string, PortfolioEquityPoint[]> = {};
  for (const portfolio of perPortfolio) perPortfolioSeries[portfolio.id] = portfolio.series;

  return {
    portfolios: perPortfolio.map((portfolio) => ({
      id: portfolio.id,
      name: portfolio.name,
      currency: portfolio.currency,
      mode: portfolio.mode,
    })),
    series,
    perPortfolioSeries,
    currency: perPortfolio[0]?.currency ?? "GBP",
  };
}