// Seeded Monte Carlo generator for synthetic global event streams.
//
// Draws a *distribution* of event tapes rather than a handful of
// hand-written scenarios: each path samples its own macro shocks, sector
// rotations, earnings gaps, flash crashes, melt-ups and liquidity
// crunches from Poisson arrival processes, layers them on a seeded GBM
// tape (`buildEventTape`), replays the AI rule-set through the no-borrow
// broker simulator (`runAiBacktest`) and scores the resulting equity
// curve.
//
// Aggregating hundreds of those paths gives the numbers a single
// backtest cannot: percentiles of terminal return, the drawdown tail,
// VaR/CVaR, probability of loss and probability of ruin.
//
// Pure module: no I/O, no clock. Every path is keyed off `baseSeed`, so
// the same config always produces byte-identical results.

import {
  buildEventTape,
  auditBacktest,
  DEFAULT_HARNESS_CAPS,
  HARNESS_UNIVERSE,
  type GlobalEvent,
  type GlobalEventKind,
  type HarnessCaps,
  type InvariantViolation,
} from "./backtest-event-harness";
import { runAiBacktest, type AiBacktestOptions } from "./ai-backtest";
import type { AssetSpec } from "./risk-sim-matrix";

// ------------------------------------------------------------------ rng

/** mulberry32 — small, fast, fully deterministic from a 32-bit seed. */
export function mcRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalDraw(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  const v = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Lognormal-ish positive magnitude with a fat right tail. */
function heavyTail(r: () => number, median: number, sigma: number): number {
  return median * Math.exp(normalDraw(r) * sigma);
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.min(xs.length - 1, Math.floor(r() * xs.length))]!;
}

function sample<T>(r: () => number, xs: readonly T[], k: number): T[] {
  const pool = [...xs];
  const out: T[] = [];
  for (let i = 0; i < k && pool.length; i++) {
    out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]!);
  }
  return out;
}

// --------------------------------------------------------------- config

/**
 * How often each event kind fires, expressed as expected occurrences per
 * 252 bars (one trading year), plus the shape of its magnitude.
 */
export type EventKindSpec = {
  /** Expected arrivals per 252 bars. 0 disables the kind. */
  ratePerYear: number;
  /** Median absolute magnitude (return, or remaining-volume fraction). */
  median: number;
  /** Lognormal sigma on the magnitude — higher = fatter tail. */
  sigma: number;
  /** Inclusive bar-duration range the effect persists for. */
  duration: [number, number];
  /** Fraction of the universe hit. 1 = market-wide. */
  breadth: number;
};

export type MonteCarloConfig = {
  /** Number of independent paths to simulate. */
  paths: number;
  /** Bars per path. */
  bars: number;
  /** Root seed — path `i` uses a derived, stable sub-seed. */
  baseSeed: number;
  universe?: AssetSpec[];
  options?: AiBacktestOptions;
  /** Override any subset of the default arrival processes. */
  intensities?: Partial<Record<GlobalEventKind, Partial<EventKindSpec>>>;
  /** Also run the full invariant audit on every path (slower). */
  audit?: boolean;
  caps?: HarnessCaps;
};

/**
 * Calibrated to a realistic-but-hostile world: roughly one meaningful
 * macro shock a year, a flash crash every ~3 years, mania melt-ups rare
 * but violent, earnings gaps frequent and single-name.
 */
export const DEFAULT_EVENT_INTENSITIES: Record<GlobalEventKind, EventKindSpec> = {
  macro_shock: { ratePerYear: 1.1, median: 0.14, sigma: 0.7, duration: [5, 25], breadth: 1 },
  sector_rotation: { ratePerYear: 2.4, median: 0.12, sigma: 0.5, duration: [10, 40], breadth: 0.4 },
  earnings_gap: { ratePerYear: 8, median: 0.07, sigma: 0.8, duration: [1, 1], breadth: 0.2 },
  flash_crash: { ratePerYear: 0.35, median: 0.22, sigma: 0.6, duration: [1, 1], breadth: 0.6 },
  melt_up: { ratePerYear: 0.5, median: 0.45, sigma: 0.9, duration: [15, 45], breadth: 0.3 },
  liquidity_crunch: { ratePerYear: 1.2, median: 0.15, sigma: 0.6, duration: [3, 15], breadth: 0.8 },
};

const EVENT_KINDS = Object.keys(DEFAULT_EVENT_INTENSITIES) as GlobalEventKind[];

function resolveIntensities(
  overrides: MonteCarloConfig["intensities"],
): Record<GlobalEventKind, EventKindSpec> {
  const out = {} as Record<GlobalEventKind, EventKindSpec>;
  for (const kind of EVENT_KINDS) {
    out[kind] = { ...DEFAULT_EVENT_INTENSITIES[kind], ...(overrides?.[kind] ?? {}) };
  }
  return out;
}

/** Stable per-path seed derived from the root seed (avalanche mix). */
export function pathSeed(baseSeed: number, index: number): number {
  let h = (baseSeed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

// ---------------------------------------------------------- generation

/**
 * Sample one synthetic global event stream.
 *
 * Arrivals are Bernoulli-thinned Poisson: each bar, each kind fires with
 * probability `ratePerYear / 252`. Direction is bearish-skewed for
 * shocks (crashes are faster than rallies), unsigned for liquidity.
 */
export function generateEventStream(
  seed: number,
  bars: number,
  symbols: string[],
  intensities: Record<GlobalEventKind, EventKindSpec> = DEFAULT_EVENT_INTENSITIES,
): GlobalEvent[] {
  const r = mcRng(seed);
  const events: GlobalEvent[] = [];

  for (let bar = 0; bar < bars; bar++) {
    for (const kind of EVENT_KINDS) {
      const spec = intensities[kind];
      if (!(spec.ratePerYear > 0)) continue;
      if (r() >= spec.ratePerYear / 252) continue;

      const [dmin, dmax] = spec.duration;
      const durationBars = Math.max(
        1,
        Math.round(dmin + r() * Math.max(0, dmax - dmin)),
      );
      const breadthCount = Math.max(
        1,
        Math.round(symbols.length * Math.min(1, Math.max(0.01, spec.breadth))),
      );
      const targets =
        breadthCount >= symbols.length ? undefined : sample(r, symbols, breadthCount);

      let magnitude: number;
      if (kind === "liquidity_crunch") {
        // Fraction of the normal book that remains — always in (0, 1).
        magnitude = Math.min(0.9, Math.max(0.01, heavyTail(r, spec.median, spec.sigma)));
      } else if (kind === "melt_up") {
        magnitude = heavyTail(r, spec.median, spec.sigma);
      } else if (kind === "flash_crash") {
        magnitude = -Math.min(0.85, heavyTail(r, spec.median, spec.sigma));
      } else {
        // Bearish skew: 60% of macro shocks / rotations / gaps are down.
        const down = r() < 0.6;
        const raw = Math.min(0.9, heavyTail(r, spec.median, spec.sigma));
        magnitude = down ? -raw : raw;
      }

      events.push({
        kind,
        barIndex: bar,
        ...(targets ? { symbols: targets } : {}),
        magnitude: Math.round(magnitude * 1e6) / 1e6,
        durationBars,
        label: `${kind}@${bar}${targets ? ` ${targets.join("/")}` : " market"}`,
      });
    }
  }
  return events;
}

// ------------------------------------------------------------- stats

export type Distribution = {
  n: number;
  mean: number;
  std: number;
  min: number;
  p1: number;
  p5: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
  p99: number;
  max: number;
};

export function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function describe(values: number[]): Distribution {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = xs.length;
  if (!n) {
    return {
      n: 0, mean: 0, std: 0, min: 0, p1: 0, p5: 0, p25: 0,
      median: 0, p75: 0, p95: 0, p99: 0, max: 0,
    };
  }
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const std =
    n > 1
      ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
      : 0;
  return {
    n,
    mean,
    std,
    min: xs[0]!,
    p1: percentile(xs, 0.01),
    p5: percentile(xs, 0.05),
    p25: percentile(xs, 0.25),
    median: percentile(xs, 0.5),
    p75: percentile(xs, 0.75),
    p95: percentile(xs, 0.95),
    p99: percentile(xs, 0.99),
    max: xs[n - 1]!,
  };
}

// ---------------------------------------------------------------- run

export type MonteCarloPath = {
  index: number;
  seed: number;
  events: number;
  /** Event counts by kind, for conditional analysis. */
  eventsByKind: Record<GlobalEventKind, number>;
  startingCash: number;
  endingEquity: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  volPct: number;
  winRatePct: number | null;
  trades: number;
  feesPaid: number;
  violations: InvariantViolation[];
};

export type MonteCarloReport = {
  config: {
    paths: number;
    bars: number;
    baseSeed: number;
    riskLevel: string;
    startingCash: number;
    audited: boolean;
  };
  paths: MonteCarloPath[];
  distributions: {
    totalReturnPct: Distribution;
    maxDrawdownPct: Distribution;
    sharpe: Distribution;
    volPct: Distribution;
    endingEquity: Distribution;
    eventsPerPath: Distribution;
  };
  risk: {
    /** Probability terminal return < 0. */
    probLossPct: number;
    /** Probability of ending below half the starting pot. */
    probRuinPct: number;
    /** Probability max drawdown breaches -20% / -35%. */
    probDrawdownWorseThan20Pct: number;
    probDrawdownWorseThan35Pct: number;
    /** 95%/99% historical VaR on terminal return (positive = loss size). */
    var95Pct: number;
    var99Pct: number;
    /** Expected shortfall in the 5%/1% left tail. */
    cvar95Pct: number;
    cvar99Pct: number;
    /** Median terminal return of paths that saw >= 1 flash crash. */
    medianReturnWithCrashPct: number | null;
    medianReturnNoCrashPct: number | null;
  };
  worstPath: MonteCarloPath | null;
  bestPath: MonteCarloPath | null;
  /** Non-empty only when `audit: true` and something broke. */
  invariantFailures: Array<{ path: number; seed: number; violations: InvariantViolation[] }>;
};

function emptyKindCounts(): Record<GlobalEventKind, number> {
  return Object.fromEntries(EVENT_KINDS.map((k) => [k, 0])) as Record<
    GlobalEventKind,
    number
  >;
}

/** Simulate a single Monte Carlo path end-to-end. */
export async function runMonteCarloPath(
  index: number,
  config: MonteCarloConfig,
): Promise<MonteCarloPath> {
  const universe = config.universe ?? HARNESS_UNIVERSE;
  const symbols = universe.map((u) => u.symbol);
  const seed = pathSeed(config.baseSeed, index);
  const intensities = resolveIntensities(config.intensities);
  const events = generateEventStream(seed, config.bars, symbols, intensities);
  const tape = buildEventTape(universe, config.bars, seed, events);
  const run = await runAiBacktest(tape.bars, config.options);

  const eventsByKind = emptyKindCounts();
  for (const e of events) eventsByKind[e.kind] += 1;

  let violations: InvariantViolation[] = [];
  if (config.audit) {
    const audit = auditBacktest(
      run,
      tape.bars,
      config.caps ?? DEFAULT_HARNESS_CAPS,
      config.options?.riskLevel ?? "balanced",
    );
    violations = audit.violations;
  }

  return {
    index,
    seed,
    events: events.length,
    eventsByKind,
    startingCash: run.summary.startingCash,
    endingEquity: run.summary.endingEquity,
    totalReturnPct: run.summary.totalReturnPct,
    maxDrawdownPct: run.summary.maxDrawdownPct,
    sharpe: run.summary.sharpe,
    volPct: run.summary.volatilityPct ?? 0,
    winRatePct: run.summary.winRatePct,
    trades: run.tradeLog.length,
    feesPaid: run.summary.feesPaid,
    violations,
  };
}

/**
 * Run the full Monte Carlo sweep and aggregate distributional risk.
 *
 * Paths are independent and deterministic in `index`, so results are
 * identical regardless of execution order.
 */
export async function runMonteCarlo(
  config: MonteCarloConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<MonteCarloReport> {
  const total = Math.max(0, Math.floor(config.paths));
  const results: MonteCarloPath[] = [];
  const concurrency = 8;

  for (let start = 0; start < total; start += concurrency) {
    const batch = [];
    for (let i = start; i < Math.min(total, start + concurrency); i++) {
      batch.push(runMonteCarloPath(i, config));
    }
    results.push(...(await Promise.all(batch)));
    onProgress?.(Math.min(total, start + concurrency), total);
  }

  results.sort((a, b) => a.index - b.index);

  const returns = results.map((p) => p.totalReturnPct);
  const sortedReturns = [...returns].sort((a, b) => a - b);
  const drawdowns = results.map((p) => p.maxDrawdownPct);
  const n = results.length || 1;

  const tailMean = (q: number) => {
    const k = Math.max(1, Math.floor(sortedReturns.length * q));
    const tail = sortedReturns.slice(0, k);
    return tail.length ? -(tail.reduce((a, b) => a + b, 0) / tail.length) : 0;
  };

  const withCrash = results.filter((p) => p.eventsByKind.flash_crash > 0);
  const noCrash = results.filter((p) => p.eventsByKind.flash_crash === 0);
  const medianOf = (rows: MonteCarloPath[]) =>
    rows.length
      ? percentile(rows.map((p) => p.totalReturnPct).sort((a, b) => a - b), 0.5)
      : null;

  const byReturn = [...results].sort((a, b) => a.totalReturnPct - b.totalReturnPct);

  return {
    config: {
      paths: total,
      bars: config.bars,
      baseSeed: config.baseSeed,
      riskLevel: String(config.options?.riskLevel ?? "balanced"),
      startingCash: results[0]?.startingCash ?? config.options?.startingCash ?? 1000,
      audited: Boolean(config.audit),
    },
    paths: results,
    distributions: {
      totalReturnPct: describe(returns),
      maxDrawdownPct: describe(drawdowns),
      sharpe: describe(results.map((p) => p.sharpe)),
      volPct: describe(results.map((p) => p.volPct)),
      endingEquity: describe(results.map((p) => p.endingEquity)),
      eventsPerPath: describe(results.map((p) => p.events)),
    },
    risk: {
      probLossPct: (results.filter((p) => p.totalReturnPct < 0).length / n) * 100,
      probRuinPct:
        (results.filter((p) => p.endingEquity < p.startingCash * 0.5).length / n) * 100,
      probDrawdownWorseThan20Pct:
        (results.filter((p) => p.maxDrawdownPct <= -20).length / n) * 100,
      probDrawdownWorseThan35Pct:
        (results.filter((p) => p.maxDrawdownPct <= -35).length / n) * 100,
      var95Pct: -percentile(sortedReturns, 0.05),
      var99Pct: -percentile(sortedReturns, 0.01),
      cvar95Pct: tailMean(0.05),
      cvar99Pct: tailMean(0.01),
      medianReturnWithCrashPct: medianOf(withCrash),
      medianReturnNoCrashPct: medianOf(noCrash),
    },
    worstPath: byReturn[0] ?? null,
    bestPath: byReturn[byReturn.length - 1] ?? null,
    invariantFailures: results
      .filter((p) => p.violations.length > 0)
      .map((p) => ({ path: p.index, seed: p.seed, violations: p.violations })),
  };
}

/** Compact, human-readable summary of a report. */
export function formatMonteCarloReport(report: MonteCarloReport): string {
  const d = report.distributions;
  const r = report.risk;
  const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  return [
    `Monte Carlo — ${report.config.paths} paths x ${report.config.bars} bars ` +
      `(risk=${report.config.riskLevel}, seed=${report.config.baseSeed})`,
    `Terminal return   median ${pct(d.totalReturnPct.median)}  mean ${pct(d.totalReturnPct.mean)}  ` +
      `p5 ${pct(d.totalReturnPct.p5)}  p95 ${pct(d.totalReturnPct.p95)}  sd ${d.totalReturnPct.std.toFixed(2)}`,
    `Max drawdown      median ${pct(d.maxDrawdownPct.median)}  p5 ${pct(d.maxDrawdownPct.p5)}  worst ${pct(d.maxDrawdownPct.min)}`,
    `Sharpe            median ${d.sharpe.median.toFixed(2)}  p5 ${d.sharpe.p5.toFixed(2)}  p95 ${d.sharpe.p95.toFixed(2)}`,
    `Risk              P(loss) ${r.probLossPct.toFixed(1)}%  P(ruin) ${r.probRuinPct.toFixed(1)}%  ` +
      `P(dd<-20%) ${r.probDrawdownWorseThan20Pct.toFixed(1)}%  P(dd<-35%) ${r.probDrawdownWorseThan35Pct.toFixed(1)}%`,
    `Tail              VaR95 ${r.var95Pct.toFixed(2)}%  CVaR95 ${r.cvar95Pct.toFixed(2)}%  ` +
      `VaR99 ${r.var99Pct.toFixed(2)}%  CVaR99 ${r.cvar99Pct.toFixed(2)}%`,
    `Crash conditional median with-crash ${r.medianReturnWithCrashPct === null ? "n/a" : pct(r.medianReturnWithCrashPct)}  ` +
      `without ${r.medianReturnNoCrashPct === null ? "n/a" : pct(r.medianReturnNoCrashPct)}`,
    `Events/path       median ${d.eventsPerPath.median.toFixed(0)}  p95 ${d.eventsPerPath.p95.toFixed(0)}`,
    report.config.audited
      ? `Invariants        ${report.invariantFailures.length === 0 ? "all paths clean" : `${report.invariantFailures.length} FAILING paths`}`
      : `Invariants        not audited`,
  ].join("\n");
}
