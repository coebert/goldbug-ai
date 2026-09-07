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
  /** True when >1 distinct source portfolio currency is present. */
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
  displayCurrency = "GBP",
  fxRates = {},
}: {
  portfolios: PortfolioEquityInput[];
  snapshots: EquitySnapshotInput[];
  today: string;
  /** Currency used by every returned monetary series. */
  displayCurrency?: string;
  /** Multipliers keyed by source currency: source amount × rate = display amount. */
  fxRates?: Record<string, number>;
}): AllPortfoliosEquity {
  const list = portfolios;
  const distinctCurrencies = Array.from(
    new Set(list.map((p) => (p.currency || "GBP").toUpperCase())),
  ).sort();
  const mixedCurrency = distinctCurrencies.length > 1;
  const outputCurrency = displayCurrency.toUpperCase();
  if (list.length === 0) {
    return {
      portfolios: [],
      series: [],
      perPortfolioSeries: {},
      currency: outputCurrency,
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
    currency: outputCurrency,
    sourceCurrency: (portfolio.currency || "GBP").toUpperCase(),
    mode: portfolio.mode ?? "paper",
    starting_cash: toNumber(portfolio.starting_cash),
    current_cash: toNumber(portfolio.current_cash),
    series: (byPortfolio.get(portfolio.id) ?? []).map((point) => ({
      ...point,
      value: point.value * (fxRates[(portfolio.currency || "GBP").toUpperCase()] ?? 1),
    })),
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
          ? portfolio.current_cash * (fxRates[portfolio.sourceCurrency] ?? 1)
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
  for (const portfolio of perPortfolio) {
    // A portfolio with no snapshots yet is still worth its cash today. Mirror
    // the combined-series rule (current_cash on `today` only, never history)
    // so the card shows the real balance instead of an empty "—".
    perPortfolioSeries[portfolio.id] =
      portfolio.series.length > 0
        ? portfolio.series
        : Number.isFinite(portfolio.current_cash)
          ? [{
              date: today,
              value: portfolio.current_cash * (fxRates[portfolio.sourceCurrency] ?? 1),
            }]
          : [];
  }

  return {
    portfolios: perPortfolio.map((portfolio) => ({
      id: portfolio.id,
      name: portfolio.name,
      currency: portfolio.currency,
      mode: portfolio.mode,
    })),
    series,
    perPortfolioSeries,
    currency: outputCurrency,
    mixedCurrency,
    currencies: distinctCurrencies,
  };
}