// Pure helpers that reconstruct time-series views from a backtest run.
// Consumed by src/lib/backtest-series.functions.ts (server) and rendered
// by src/components/backtest-results-card.tsx.

export type TradeRow = {
  trade_date: string;
  executed_at?: string | null;
  side: "buy" | "sell";
  symbol: string;
  quantity: number;
  price: number;
  fees?: number | null;
};

export type PriceRow = { symbol: string; price_date: string; close: number };

export type EquityRow = { snapshot_date: string; total_value: number };

export type HoldingsPoint = {
  date: string;
  cash: number;
  total: number;
  [symbol: string]: number | string;
};

export type HoldingsOverTime = {
  symbols: string[];
  points: HoldingsPoint[];
};

/** Build a per-date map of latest close on/before each date, per symbol. */
export function indexPricesForward(
  prices: PriceRow[],
  symbols: string[],
  dates: string[],
): Map<string, Map<string, number>> {
  const bySymbol = new Map<string, Array<{ d: string; c: number }>>();
  for (const s of symbols) bySymbol.set(s, []);
  for (const p of prices) {
    const arr = bySymbol.get(p.symbol);
    if (arr) arr.push({ d: p.price_date, c: p.close });
  }
  for (const arr of bySymbol.values()) arr.sort((a, b) => a.d.localeCompare(b.d));

  const out = new Map<string, Map<string, number>>();
  for (const s of symbols) {
    const arr = bySymbol.get(s) ?? [];
    let i = 0;
    let last: number | null = null;
    const perDate = new Map<string, number>();
    for (const d of dates) {
      while (i < arr.length && arr[i].d <= d) {
        last = arr[i].c;
        i++;
      }
      if (last != null) perDate.set(d, last);
    }
    out.set(s, perDate);
  }
  return out;
}

/**
 * Reconstruct holdings-over-time by folding trades chronologically and
 * marking each snapshot date to the last known close for each held symbol.
 *
 * `startingCash` is the portfolio's initial cash on/before the first date.
 * Cash is adjusted by trade notionals only (fees ignored for chart clarity;
 * detailed PnL lives in the metrics card).
 */
export function buildHoldingsOverTime(
  trades: TradeRow[],
  snapshotDates: string[],
  prices: PriceRow[],
  startingCash: number,
): HoldingsOverTime {
  const dates = [...snapshotDates].sort();
  const symbols = Array.from(new Set(trades.map((t) => t.symbol))).sort();
  const priceIndex = indexPricesForward(prices, symbols, dates);

  // Trades sorted by (trade_date, executed_at) — mirrors metrics module.
  const sortedTrades = [...trades].sort((a, b) => {
    const d = a.trade_date.localeCompare(b.trade_date);
    if (d !== 0) return d;
    return (a.executed_at ?? "").localeCompare(b.executed_at ?? "");
  });

  const qty = new Map<string, number>();
  for (const s of symbols) qty.set(s, 0);
  let cash = startingCash;
  let ti = 0;

  const points: HoldingsPoint[] = [];
  for (const date of dates) {
    // Apply all trades whose trade_date <= this snapshot date.
    while (ti < sortedTrades.length && sortedTrades[ti].trade_date <= date) {
      const t = sortedTrades[ti++];
      const notional = t.quantity * t.price;
      if (t.side === "buy") {
        qty.set(t.symbol, (qty.get(t.symbol) ?? 0) + t.quantity);
        cash -= notional;
      } else {
        qty.set(t.symbol, (qty.get(t.symbol) ?? 0) - t.quantity);
        cash += notional;
      }
    }

    const point: HoldingsPoint = { date, cash, total: cash };
    for (const s of symbols) {
      const q = qty.get(s) ?? 0;
      const mark = priceIndex.get(s)?.get(date);
      const value = q !== 0 && mark != null ? q * mark : 0;
      point[s] = value;
      point.total += value;
    }
    points.push(point);
  }

  // Trim symbols that never held any value in the window — keeps the legend tidy.
  const kept = symbols.filter((s) => points.some((p) => Number(p[s] ?? 0) > 0.000001));
  if (kept.length !== symbols.length) {
    for (const p of points) {
      for (const s of symbols) {
        if (!kept.includes(s)) delete (p as Record<string, number>)[s];
      }
    }
  }
  return { symbols: kept, points };
}

/** Slice an equity curve to the last N days (inclusive of the final point). */
export function tailEquity(equity: EquityRow[], days: number): EquityRow[] {
  if (equity.length <= days) return [...equity];
  return equity.slice(equity.length - days);
}
