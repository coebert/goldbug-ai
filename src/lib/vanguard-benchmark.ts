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

/**
 * Time-weighted return of the portfolio computed from an equity series
 * and dated deposits. Segment returns are chained after netting deposits
 * that land inside each segment, so cash top-ups don't inflate skill.
 */
export function portfolioTWR(
  equity: EquityPoint[],
  deposits: DepositLike[] = [],
): number {
  const clean = equity
    .filter((e) => Number.isFinite(Number(e.total_value)) && !!e.snapshot_date)
    .slice()
    .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  if (clean.length < 2) return 0;
  const deps = deposits
    .filter((d) => Number.isFinite(Number(d.amount)) && !!d.date)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  let twr = 1;
  for (let i = 1; i < clean.length; i++) {
    const prev = clean[i - 1];
    const cur = clean[i];
    const prevVal = Number(prev.total_value);
    const curVal = Number(cur.total_value);
    if (!(prevVal > 0)) continue;
    const depsIn = deps.reduce((a, d) => {
      const t = d.date;
      return t > prev.snapshot_date && t <= cur.snapshot_date
        ? a + Number(d.amount)
        : a;
    }, 0);
    const seg = (curVal - depsIn) / prevVal - 1;
    if (Number.isFinite(seg)) twr *= 1 + seg;
  }
  return twr - 1;
}

export interface AlphaAttribution {
  timing: number; // selection skill per £, sized to contributed capital
  allocation: number; // residual: deposit-weighted vs time-weighted skill diff
  depositTiming: number; // effect of deposit schedule on the passive baseline
  total: number; // alphaCcy = timing + allocation + depositTiming
  portfolioTwrPct: number;
  benchmarkTwrPct: number;
}

/**
 * Decompose the currency alpha vs the Vanguard 60/40 passive proxy into
 * three intuitive drivers:
 *
 *   • Timing (skill)  = contributed × (portfolio TWR − benchmark TWR)
 *   • Deposits timing = lump-sum-passive − actual-passive  (schedule effect)
 *   • Allocation      = residual (portfolio final − TWR-implied final)
 *
 * By construction: timing + allocation + depositTiming === alphaCcy.
 */
export function attributeAlpha(
  cmp: VanguardComparison,
  equity: EquityPoint[],
  deposits: DepositLike[] = [],
  cagr = VANGUARD_CAGR,
): AlphaAttribution {
  const pTwr = portfolioTWR(equity, deposits);
  const bTwr = cmp.days > 0 ? Math.pow(1 + cagr, cmp.days / 365) - 1 : 0;
  const lumpSumBench = cmp.contributed * (1 + bTwr);
  const lumpSumPort = cmp.contributed * (1 + pTwr);

  const timing = lumpSumPort - lumpSumBench;
  const depositTiming = lumpSumBench - cmp.benchmarkValue;
  const allocation = cmp.portfolioValue - lumpSumPort;

  return {
    timing,
    allocation,
    depositTiming,
    total: cmp.alphaCcy,
    portfolioTwrPct: pTwr * 100,
    benchmarkTwrPct: bTwr * 100,
  };
}

// ---------------------------------------------------------------------------
// Risk-level "what-if" simulation
// ---------------------------------------------------------------------------

export type RiskLevelKey = "conservative" | "balanced" | "aggressive";

/**
 * Preset profile per risk level, mirroring `riskProfile()` in
 * universe.server.ts. Duplicated here (as plain numbers) so this module
 * stays server-runtime free and safe to import from the client bundle.
 */
export const RISK_PRESETS: Record<
  RiskLevelKey,
  { maxPositionPct: number; cashFloorPct: number; label: string }
> = {
  conservative: { maxPositionPct: 0.10, cashFloorPct: 0.20, label: "Conservative" },
  balanced:     { maxPositionPct: 0.15, cashFloorPct: 0.10, label: "Balanced" },
  aggressive:   { maxPositionPct: 0.25, cashFloorPct: 0.00, label: "Aggressive" },
};

function normaliseRiskKey(level: string | null | undefined): RiskLevelKey {
  const k = (level ?? "").toLowerCase();
  if (k === "conservative" || k === "balanced" || k === "aggressive") return k;
  return "balanced";
}

export interface SimulatedAlpha {
  level: RiskLevelKey;
  label: string;
  isCurrent: boolean;
  timing: number;
  allocation: number;
  depositTiming: number;
  total: number;
  exposureFactor: number;   // scales timing (equity exposure vs current)
  concentrationFactor: number; // scales allocation (position cap vs current)
}

/**
 * Project what the alpha attribution would have looked like under each risk
 * preset, given the *current* run's realised drivers.
 *
 * Model (kept deliberately simple and transparent):
 *   • Timing scales with equity exposure     = (1 − cashFloor(level)) / (1 − cashFloor(current))
 *   • Allocation scales with position cap    = maxPos(level) / maxPos(current)
 *   • Deposit timing is untouched — it lives in the passive baseline, not the AI.
 *
 * This is a linear counterfactual, not a full re-simulation of trades. It's
 * meant to show the *shape* of how risk dials would have amplified or
 * dampened the two skill components, not a promise of exact P&L.
 */
export function simulateAlphaAtRiskLevels(
  attr: AlphaAttribution,
  currentLevel: string | null | undefined,
): SimulatedAlpha[] {
  const current = normaliseRiskKey(currentLevel);
  const cur = RISK_PRESETS[current];
  const curExposure = Math.max(0.01, 1 - cur.cashFloorPct);
  const curPos = Math.max(0.001, cur.maxPositionPct);

  const levels: RiskLevelKey[] = ["conservative", "balanced", "aggressive"];
  return levels.map((level) => {
    const p = RISK_PRESETS[level];
    const exposureFactor = (1 - p.cashFloorPct) / curExposure;
    const concentrationFactor = p.maxPositionPct / curPos;
    const timing = attr.timing * exposureFactor;
    const allocation = attr.allocation * concentrationFactor;
    const depositTiming = attr.depositTiming;
    return {
      level,
      label: p.label,
      isCurrent: level === current,
      timing,
      allocation,
      depositTiming,
      total: timing + allocation + depositTiming,
      exposureFactor,
      concentrationFactor,
    };
  });
}
