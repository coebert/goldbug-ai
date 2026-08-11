/**
 * Relative strength: how each owned stock is performing against the market
 * average it should be judged on.
 *
 * The point of this module is a continuous, like-for-like read on whether the
 * book is actually earning its keep. A holding that is up 3% in a month looks
 * good until you notice its index is up 6% — that is a 3pp drag, not a win.
 * Everything here is pure and unit-agnostic (percentage returns cancel any
 * GBX/GBP scaling), so callers can feed raw cache series straight in as long
 * as each individual series is internally consistent.
 */

export type PricePoint = { date: string; close: number };

export type HoldingInput = {
  symbol: string;
  quantity: number;
  /** Cost basis per share in the portfolio's base currency. */
  avgCost: number;
  openedAt: string | null;
  assetClass?: string | null;
};

export type BenchmarkRef = { symbol: string; label: string };

/** Trailing windows, in trading sessions, we score every holding over. */
export const RS_WINDOWS = [
  { key: "d1", sessions: 1, label: "1d" },
  { key: "d5", sessions: 5, label: "1w" },
  { key: "d21", sessions: 21, label: "1m" },
  { key: "d63", sessions: 63, label: "3m" },
] as const;

export type RsWindowKey = (typeof RS_WINDOWS)[number]["key"];

export type WindowComparison = {
  key: RsWindowKey;
  label: string;
  /** Holding return over the window, in percent. Null when history is short. */
  holdingPct: number | null;
  /** Benchmark return over the same window, in percent. */
  benchmarkPct: number | null;
  /** Holding minus benchmark, in percentage points. */
  excessPct: number | null;
};

export type Verdict = "leading" | "inline" | "lagging" | "unknown";

export type HoldingComparison = {
  symbol: string;
  benchmark: BenchmarkRef;
  quantity: number;
  /** Latest close in base units; null when no price is cached. */
  price: number | null;
  /** Current market value in base currency. */
  value: number | null;
  windows: WindowComparison[];
  /** Return since the position was opened, measured off avg cost. */
  sincePurchasePct: number | null;
  /** Benchmark return over the same holding period. */
  benchmarkSincePurchasePct: number | null;
  /** Since-purchase excess return, in percentage points. */
  sincePurchaseExcessPct: number | null;
  /**
   * Money left on the table (negative) or won (positive) versus simply
   * putting the same cash into the benchmark on the day we bought.
   */
  excessValue: number | null;
  verdict: Verdict;
  /** Short plain-language read of the comparison. */
  note: string;
};

export type PortfolioComparison = {
  asOf: string | null;
  holdings: HoldingComparison[];
  /** Value-weighted excess return per window, in percentage points. */
  weightedExcess: Record<RsWindowKey, number | null>;
  /** Value-weighted since-purchase excess, in percentage points. */
  weightedSincePurchaseExcess: number | null;
  /** Sum of per-holding excess value in base currency. */
  totalExcessValue: number;
  leaders: number;
  laggards: number;
  totalValue: number;
};

/** Excess return, in pp, beyond which we call a holding a leader/laggard. */
export const VERDICT_BAND_PP = 1;

const LSE = /\.L$|:xlon$/i;
const CRYPTO = /-USD$|^BTC|^ETH|^SOL/i;
const EURO = /\.(DE|PA|AS|MI|MC|SW|ST|CO|HE|OL)$|:(xetr|xpar|xams|xmil|xmad|xswx|xsto|xcse|xhel|xose)$/i;

/** The world tracker we fall back to when a venue-specific index is missing. */
export const FALLBACK_BENCHMARK: BenchmarkRef = { symbol: "VWRL.L", label: "World equities" };

/**
 * Choose the market average a symbol should be measured against: its own
 * venue's index, not an arbitrary global one. A London retailer beating the
 * S&P is mostly a currency and sector accident; beating the FTSE 100 is not.
 */
export function pickBenchmark(symbol: string, assetClass?: string | null): BenchmarkRef {
  const s = String(symbol || "");
  if (assetClass === "crypto" || CRYPTO.test(s)) return { symbol: "BTC-USD", label: "Crypto majors" };
  if (assetClass === "commodity") return { symbol: "GLD", label: "Gold" };
  if (LSE.test(s)) return { symbol: "ISF.L", label: "FTSE 100" };
  if (EURO.test(s)) return { symbol: "EFA", label: "Developed ex-US" };
  if (/[.:]/.test(s)) return FALLBACK_BENCHMARK;
  return { symbol: "SPY", label: "S&P 500" };
}

function clean(series: readonly PricePoint[] | undefined | null): PricePoint[] {
  if (!Array.isArray(series)) return [];
  return series
    .filter((p) => p && typeof p.date === "string" && Number.isFinite(Number(p.close)) && Number(p.close) > 0)
    .map((p) => ({ date: p.date, close: Number(p.close) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Percent change over the last `sessions` bars. Null when history is short. */
export function windowReturnPct(series: readonly PricePoint[], sessions: number): number | null {
  const s = clean(series);
  if (s.length < sessions + 1 || sessions < 1) return null;
  const last = s[s.length - 1]!.close;
  const prev = s[s.length - 1 - sessions]!.close;
  if (!(prev > 0)) return null;
  return ((last - prev) / prev) * 100;
}

/** Percent change from the first bar on or after `fromDate` to the last bar. */
export function returnSincePct(series: readonly PricePoint[], fromDate: string | null): number | null {
  const s = clean(series);
  if (s.length === 0) return null;
  const start = fromDate ? s.find((p) => p.date >= fromDate.slice(0, 10)) ?? null : s[0]!;
  if (!start || !(start.close > 0)) return null;
  const last = s[s.length - 1]!.close;
  return ((last - start.close) / start.close) * 100;
}

function verdictFor(excess: number | null): Verdict {
  if (excess == null || !Number.isFinite(excess)) return "unknown";
  if (excess >= VERDICT_BAND_PP) return "leading";
  if (excess <= -VERDICT_BAND_PP) return "lagging";
  return "inline";
}

function pp(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`;
}

function noteFor(
  symbol: string,
  benchmark: BenchmarkRef,
  monthly: WindowComparison | undefined,
  sinceExcess: number | null,
  verdict: Verdict,
): string {
  if (verdict === "unknown") return `Not enough price history yet to compare ${symbol} with ${benchmark.label}.`;
  const monthPart =
    monthly?.excessPct != null
      ? ` Over the last month it is ${pp(monthly.excessPct)} versus the index.`
      : "";
  if (verdict === "leading") {
    return `${symbol} is beating ${benchmark.label} by ${pp(sinceExcess ?? 0)} since we bought it.${monthPart}`;
  }
  if (verdict === "lagging") {
    return `${symbol} is behind ${benchmark.label} by ${pp(sinceExcess ?? 0)} since we bought it — the same money in the index would have done better.${monthPart}`;
  }
  return `${symbol} is tracking ${benchmark.label} closely (${pp(sinceExcess ?? 0)} since purchase).${monthPart}`;
}

/**
 * Compare one holding with its market average across every trailing window
 * plus the actual holding period.
 */
export function compareHolding(args: {
  holding: HoldingInput;
  series: readonly PricePoint[];
  benchmark: BenchmarkRef;
  benchmarkSeries: readonly PricePoint[];
}): HoldingComparison {
  const { holding, benchmark } = args;
  const series = clean(args.series);
  const bench = clean(args.benchmarkSeries);

  const price = series.length > 0 ? series[series.length - 1]!.close : null;
  const qty = Number(holding.quantity);
  const value = price != null && Number.isFinite(qty) ? price * qty : null;

  const windows: WindowComparison[] = RS_WINDOWS.map((w) => {
    const holdingPct = windowReturnPct(series, w.sessions);
    const benchmarkPct = windowReturnPct(bench, w.sessions);
    return {
      key: w.key,
      label: w.label,
      holdingPct,
      benchmarkPct,
      excessPct: holdingPct != null && benchmarkPct != null ? holdingPct - benchmarkPct : null,
    };
  });

  // Since-purchase uses the recorded cost basis rather than a cached close, so
  // it reflects what we actually paid (slippage and fees included upstream).
  const cost = Number(holding.avgCost);
  const sincePurchasePct = price != null && cost > 0 ? ((price - cost) / cost) * 100 : null;
  const benchmarkSincePurchasePct = returnSincePct(bench, holding.openedAt);
  const sinceExcess =
    sincePurchasePct != null && benchmarkSincePurchasePct != null
      ? sincePurchasePct - benchmarkSincePurchasePct
      : null;

  const investedCost = cost > 0 && Number.isFinite(qty) ? cost * qty : null;
  const excessValue =
    investedCost != null && sinceExcess != null ? (investedCost * sinceExcess) / 100 : null;

  const verdict = verdictFor(sinceExcess);

  return {
    symbol: holding.symbol,
    benchmark,
    quantity: Number.isFinite(qty) ? qty : 0,
    price,
    value,
    windows,
    sincePurchasePct,
    benchmarkSincePurchasePct,
    sincePurchaseExcessPct: sinceExcess,
    excessValue,
    verdict,
    note: noteFor(holding.symbol, benchmark, windows.find((w) => w.key === "d21"), sinceExcess, verdict),
  };
}

function weighted(rows: HoldingComparison[], pick: (r: HoldingComparison) => number | null): number | null {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    const x = pick(r);
    const w = r.value;
    if (x == null || !Number.isFinite(x) || w == null || !(w > 0)) continue;
    num += x * w;
    den += w;
  }
  return den > 0 ? num / den : null;
}

/**
 * Roll per-holding comparisons up into a single book-level read, weighting by
 * position size so a token holding cannot flatter the headline.
 */
export function comparePortfolio(rows: HoldingComparison[], asOf: string | null = null): PortfolioComparison {
  const weightedExcess = Object.fromEntries(
    RS_WINDOWS.map((w) => [
      w.key,
      weighted(rows, (r) => r.windows.find((x) => x.key === w.key)?.excessPct ?? null),
    ]),
  ) as Record<RsWindowKey, number | null>;

  return {
    asOf,
    holdings: [...rows].sort((a, b) => (b.sincePurchaseExcessPct ?? -Infinity) - (a.sincePurchaseExcessPct ?? -Infinity)),
    weightedExcess,
    weightedSincePurchaseExcess: weighted(rows, (r) => r.sincePurchaseExcessPct),
    totalExcessValue: rows.reduce((acc, r) => acc + (r.excessValue ?? 0), 0),
    leaders: rows.filter((r) => r.verdict === "leading").length,
    laggards: rows.filter((r) => r.verdict === "lagging").length,
    totalValue: rows.reduce((acc, r) => acc + (r.value ?? 0), 0),
  };
}
