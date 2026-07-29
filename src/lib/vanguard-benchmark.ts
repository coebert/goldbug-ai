/**
 * Vanguard passive benchmark helpers.
 *
 * Models the Vanguard LifeStrategy 60% Equity (VLS60 / a 60/40 world
 * equity + gilt mix) as a smooth compounder growing at a fixed long-run
 * CAGR. Deposits made mid-run are added to the benchmark on the same date
 * they hit the portfolio so the comparison is like-for-like (pure trading
 * skill vs a boring, low-cost passive alternative).
 *
 * Kept dependency-free so it can be re-used by other perf surfaces.
 */

export type EquityPoint = { snapshot_date: string; total_value: number };
export type DepositLike = { date: string; amount: number };

// Long-run expected return for Vanguard LifeStrategy 60 (~5.5% net, GBP).
// Sourced from Vanguard's own 10-year capital markets assumptions; this is
// a neutral proxy and intentionally conservative.
export const VANGUARD_CAGR = 0.055;

const MS_PER_DAY = 86_400_000;

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, (b - a) / MS_PER_DAY);
}

/**
 * Compound `principal` at `cagr` for `days` calendar days.
 */
export function compound(principal: number, days: number, cagr = VANGUARD_CAGR): number {
  if (!(principal > 0) || days <= 0) return principal;
  return principal * Math.pow(1 + cagr, days / 365);
}

/**
 * Compute the benchmark value on `asOf` given the starting cash and any
 * deposits added along the way. Each deposit is compounded from its own
 * date, mirroring how it would have been invested in VLS60 that day.
 */
export function benchmarkValueAt(
  startingCash: number,
  startDate: string,
  deposits: DepositLike[],
  asOf: string,
  cagr = VANGUARD_CAGR,
): number {
  const base = compound(startingCash, daysBetween(startDate, asOf), cagr);
  const grownDeposits = deposits.reduce((acc, d) => {
    const amt = Number(d.amount);
    if (!Number.isFinite(amt) || amt === 0) return acc;
    // Skip deposits dated after the as-of point.
    if (Date.parse(d.date) > Date.parse(asOf)) return acc;
    return acc + compound(amt, daysBetween(d.date, asOf), cagr);
  }, 0);
  return base + grownDeposits;
}

export interface VanguardComparison {
  startDate: string | null;
  asOf: string | null;
  portfolioValue: number;
  benchmarkValue: number;
  contributed: number; // starting cash + net deposits
  portfolioReturnPct: number;
  benchmarkReturnPct: number;
  alphaPct: number; // portfolio − benchmark
  alphaCcy: number; // absolute currency delta
  days: number;
}

/**
 * Build a portfolio vs Vanguard 60/40 comparison from an equity series.
 */
export function compareToVanguard(
  startingCash: number,
  equity: EquityPoint[],
  deposits: DepositLike[] = [],
  cagr = VANGUARD_CAGR,
): VanguardComparison {
  const clean = equity
    .filter((e) => Number.isFinite(Number(e.total_value)) && !!e.snapshot_date)
    .slice()
    .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));

  if (!clean.length) {
    return {
      startDate: null,
      asOf: null,
      portfolioValue: startingCash,
      benchmarkValue: startingCash,
      contributed: startingCash,
      portfolioReturnPct: 0,
      benchmarkReturnPct: 0,
      alphaPct: 0,
      alphaCcy: 0,
      days: 0,
    };
  }

  const first = clean[0];
  const last = clean[clean.length - 1];
  const startDate = first.snapshot_date;
  const asOf = last.snapshot_date;
  const days = daysBetween(startDate, asOf);
  const portfolioValue = Number(last.total_value);

  const depNet = deposits.reduce((a, d) => a + (Number(d.amount) || 0), 0);
  const contributed = startingCash + depNet;

  const benchmarkValue = benchmarkValueAt(startingCash, startDate, deposits, asOf, cagr);

  const pRet = contributed > 0 ? ((portfolioValue - contributed) / contributed) * 100 : 0;
  const bRet = contributed > 0 ? ((benchmarkValue - contributed) / contributed) * 100 : 0;

  return {
    startDate,
    asOf,
    portfolioValue,
    benchmarkValue,
    contributed,
    portfolioReturnPct: pRet,
    benchmarkReturnPct: bRet,
    alphaPct: pRet - bRet,
    alphaCcy: portfolioValue - benchmarkValue,
    days,
  };
}

export type BenchmarkSeriesPoint = {
  date: string;
  portfolio: number;
  benchmark: number;
};

/**
 * Build an aligned equity-curve series for portfolio vs the passive
 * Vanguard 60/40 proxy, using the portfolio's own snapshot dates as the
 * time axis. Benchmark values are compounded from the first snapshot,
 * with deposits added on their own date.
 */
export function buildBenchmarkSeries(
  startingCash: number,
  equity: EquityPoint[],
  deposits: DepositLike[] = [],
  cagr = VANGUARD_CAGR,
): BenchmarkSeriesPoint[] {
  const clean = equity
    .filter((e) => Number.isFinite(Number(e.total_value)) && !!e.snapshot_date)
    .slice()
    .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  if (!clean.length) return [];
  const startDate = clean[0].snapshot_date;
  return clean.map((p) => ({
    date: p.snapshot_date,
    portfolio: Number(p.total_value),
    benchmark: benchmarkValueAt(startingCash, startDate, deposits, p.snapshot_date, cagr),
  }));
}
