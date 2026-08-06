// Regime-segmented walk-forward evaluation.
//
// A single all-history backtest hides the thing that actually matters: does
// the optimised parameter set keep its net CAGR and its drawdown discipline
// when the tape is *only* bull, *only* bear, or *only* chop?
//
// This module is the pure half of that answer:
//   * build a benchmark index from the tape,
//   * label every bar bull / bear / sideways from trailing trend + drawdown,
//   * cut the history into rolling train/test walk-forward windows,
//   * tag each out-of-sample window with the regime it mostly lived in,
//   * aggregate net CAGR and drawdown per regime, with a stability read.
//
// No network, no broker, no database — all deterministic so the verdicts
// can be unit tested.

import type { EquityPoint } from "./backtest-metrics";

export type RegimeLabel = "bull" | "bear" | "sideways";
export const REGIMES: readonly RegimeLabel[] = ["bull", "bear", "sideways"] as const;

export type IndexPoint = { date: string; value: number };

/** Bars as produced by `buildRealTape` — only what this module needs. */
export type TapeBarLike = { date: string; closes: Record<string, number> };

/**
 * Equal-weight benchmark index from the tape, rebased to 100. Symbols that
 * appear late simply join from their first observation, so the index never
 * jumps on a new listing.
 */
export function benchmarkIndex(bars: readonly TapeBarLike[]): IndexPoint[] {
  if (bars.length === 0) return [];
  const first: Record<string, number> = {};
  const out: IndexPoint[] = [];
  for (const bar of bars) {
    const ratios: number[] = [];
    for (const [sym, close] of Object.entries(bar.closes)) {
      if (!(close > 0)) continue;
      if (first[sym] === undefined) first[sym] = close;
      ratios.push(close / first[sym]!);
    }
    const value = ratios.length ? (ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100 : (out.at(-1)?.value ?? 100);
    out.push({ date: bar.date, value });
  }
  return out;
}

export type RegimeThresholds = {
  /** Trailing window, in bars, used for the trend read (default 63 ≈ 1 quarter). */
  lookback: number;
  /** Annualised trailing return above which the tape is bull, in % (default 10). */
  bullAnnualPct: number;
  /** Annualised trailing return below which the tape is bear, in % (default -10). */
  bearAnnualPct: number;
  /** Drawdown from the running peak that forces a bear label, in % (default 15). */
  bearDrawdownPct: number;
  /** Bars per year used to annualise (default 252). */
  barsPerYear: number;
};

export const DEFAULT_REGIME_THRESHOLDS: RegimeThresholds = {
  lookback: 63,
  bullAnnualPct: 10,
  bearAnnualPct: -10,
  bearDrawdownPct: 15,
  barsPerYear: 252,
};

/** Annualised return implied by a start/end level over `bars` bars, in %. */
export function annualisedPct(startValue: number, endValue: number, bars: number, barsPerYear = 252): number {
  if (!(startValue > 0) || !(endValue > 0) || bars <= 0) return 0;
  const years = bars / barsPerYear;
  if (!(years > 0)) return 0;
  return ((endValue / startValue) ** (1 / years) - 1) * 100;
}

/**
 * Per-bar regime label. A deep drawdown from the running peak overrides the
 * trend read — a bounce inside a 25% drawdown is still a bear tape.
 */
export function classifyRegimes(
  index: readonly IndexPoint[],
  thresholds: Partial<RegimeThresholds> = {},
): RegimeLabel[] {
  const t = { ...DEFAULT_REGIME_THRESHOLDS, ...thresholds };
  if (t.lookback < 1) throw new Error("classifyRegimes: lookback must be >= 1");
  if (t.bearAnnualPct >= t.bullAnnualPct) {
    throw new Error("classifyRegimes: bearAnnualPct must be below bullAnnualPct");
  }
  const out: RegimeLabel[] = [];
  let peak = index[0]?.value ?? 0;
  for (let i = 0; i < index.length; i++) {
    const value = index[i]!.value;
    if (value > peak) peak = value;
    const drawdownPct = peak > 0 ? ((value - peak) / peak) * 100 : 0;
    const back = Math.min(i, t.lookback);
    const startValue = index[i - back]?.value ?? value;
    const trend = back > 0 ? annualisedPct(startValue, value, back, t.barsPerYear) : 0;

    if (drawdownPct <= -t.bearDrawdownPct) out.push("bear");
    else if (trend >= t.bullAnnualPct) out.push("bull");
    else if (trend <= t.bearAnnualPct) out.push("bear");
    else out.push("sideways");
  }
  return out;
}

export type RegimeSegment = {
  label: RegimeLabel;
  startIndex: number;
  endIndex: number;
  from: string;
  to: string;
  bars: number;
};

/**
 * Collapse per-bar labels into contiguous segments, absorbing runs shorter
 * than `minBars` into the preceding segment so single-day flickers do not
 * shred the history into unusable slivers.
 */
export function segmentRegimes(
  index: readonly IndexPoint[],
  labels: readonly RegimeLabel[],
  minBars = 21,
): RegimeSegment[] {
  if (index.length !== labels.length) {
    throw new Error("segmentRegimes: index and labels must be the same length");
  }
  const raw: RegimeSegment[] = [];
  for (let i = 0; i < labels.length; i++) {
    const last = raw.at(-1);
    if (last && last.label === labels[i]) {
      last.endIndex = i;
      last.to = index[i]!.date;
      last.bars += 1;
    } else {
      raw.push({
        label: labels[i]!,
        startIndex: i,
        endIndex: i,
        from: index[i]!.date,
        to: index[i]!.date,
        bars: 1,
      });
    }
  }
  const merged: RegimeSegment[] = [];
  for (const seg of raw) {
    const prev = merged.at(-1);
    // A short run is absorbed into the preceding segment; so is any run
    // that ends up adjacent to a segment carrying the same label.
    if (prev && (seg.bars < minBars || prev.label === seg.label)) {
      prev.endIndex = seg.endIndex;
      prev.to = seg.to;
      prev.bars += seg.bars;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

export type WalkForwardWindow = {
  index: number;
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
};

/**
 * Rolling train/test split. `trainBars` is in-sample context the strategy is
 * allowed to warm up on; `testBars` is the out-of-sample slice that is
 * actually scored. Windows advance by `step` (default: the test length, so
 * out-of-sample slices never overlap).
 */
export function walkForwardWindows(
  totalBars: number,
  opts: { trainBars: number; testBars: number; step?: number },
): WalkForwardWindow[] {
  const { trainBars, testBars } = opts;
  const step = opts.step ?? testBars;
  if (trainBars < 0) throw new Error("walkForwardWindows: trainBars must be >= 0");
  if (testBars < 1) throw new Error("walkForwardWindows: testBars must be >= 1");
  if (step < 1) throw new Error("walkForwardWindows: step must be >= 1");
  const out: WalkForwardWindow[] = [];
  for (let start = 0; start + trainBars + testBars <= totalBars; start += step) {
    out.push({
      index: out.length,
      trainStart: start,
      trainEnd: start + trainBars,
      testStart: start + trainBars,
      testEnd: start + trainBars + testBars,
    });
  }
  return out;
}

/** Majority regime over a bar range; ties resolve bear > bull > sideways. */
export function dominantRegime(
  labels: readonly RegimeLabel[],
  start: number,
  end: number,
): { label: RegimeLabel; purity: number } {
  const slice = labels.slice(start, end);
  if (slice.length === 0) return { label: "sideways", purity: 0 };
  const counts: Record<RegimeLabel, number> = { bull: 0, bear: 0, sideways: 0 };
  for (const l of slice) counts[l] += 1;
  const order: RegimeLabel[] = ["bear", "bull", "sideways"];
  let best = order[0]!;
  for (const l of order) if (counts[l] > counts[best]) best = l;
  return { label: best, purity: counts[best] / slice.length };
}

// ------------------------------------------------------------- scoring

/** Net CAGR of an equity curve over `bars` bars, in %. */
export function curveCagrPct(curve: readonly EquityPoint[], barsPerYear = 252): number {
  if (curve.length < 2) return 0;
  return annualisedPct(
    curve[0]!.total_value,
    curve.at(-1)!.total_value,
    curve.length - 1,
    barsPerYear,
  );
}

/** Max drawdown of an equity curve as a negative percentage. */
export function curveMaxDrawdownPct(curve: readonly EquityPoint[]): number {
  let peak = curve[0]?.total_value ?? 0;
  let worst = 0;
  for (const p of curve) {
    if (p.total_value > peak) peak = p.total_value;
    const dd = peak > 0 ? ((p.total_value - peak) / peak) * 100 : 0;
    if (dd < worst) worst = dd;
  }
  return worst;
}

export type WindowResult = {
  window: WalkForwardWindow;
  regime: RegimeLabel;
  purity: number;
  from: string;
  to: string;
  netCagrPct: number;
  maxDrawdownPct: number;
  benchmarkCagrPct: number;
  trades: number;
  tradesPerYear: number;
  feeDragPct: number;
  sharpe: number;
};

export type RegimeSummary = {
  regime: RegimeLabel;
  windows: number;
  bars: number;
  medianNetCagrPct: number;
  meanNetCagrPct: number;
  worstNetCagrPct: number;
  bestNetCagrPct: number;
  /** Standard deviation of window CAGR — lower is more stable. */
  cagrStdPct: number;
  medianMaxDrawdownPct: number;
  worstMaxDrawdownPct: number;
  medianBenchmarkCagrPct: number;
  /** Share of windows with a positive net CAGR. */
  positiveRate: number;
  /** Share of windows beating the benchmark. */
  beatBenchmarkRate: number;
  medianTradesPerYear: number;
  /** True when every window respected the drawdown ceiling. */
  drawdownStable: boolean;
  /** True when the regime is profitable and drawdown-stable throughout. */
  pass: boolean;
};

export function median(values: readonly number[]): number {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

export function stdev(values: readonly number[]): number {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
}

export type RegimeGate = {
  /** Drawdown ceiling as a positive magnitude, in % (default 25). */
  maxDrawdownPct: number;
  /** Median net CAGR a regime must clear, in % (default 0). */
  minMedianCagrPct: number;
  /** Share of windows that must be profitable (default 0.5). */
  minPositiveRate: number;
};

export const DEFAULT_REGIME_GATE: RegimeGate = {
  maxDrawdownPct: 25,
  minMedianCagrPct: 0,
  minPositiveRate: 0.5,
};

/** Aggregate the out-of-sample windows that fell in one regime. */
export function summariseRegime(
  regime: RegimeLabel,
  results: readonly WindowResult[],
  gate: Partial<RegimeGate> = {},
): RegimeSummary {
  const g = { ...DEFAULT_REGIME_GATE, ...gate };
  const rows = results.filter((r) => r.regime === regime);
  if (rows.length === 0) {
    return {
      regime,
      windows: 0,
      bars: 0,
      medianNetCagrPct: 0,
      meanNetCagrPct: 0,
      worstNetCagrPct: 0,
      bestNetCagrPct: 0,
      cagrStdPct: 0,
      medianMaxDrawdownPct: 0,
      worstMaxDrawdownPct: 0,
      medianBenchmarkCagrPct: 0,
      positiveRate: 0,
      beatBenchmarkRate: 0,
      medianTradesPerYear: 0,
      drawdownStable: true,
      pass: false,
    };
  }
  const cagrs = rows.map((r) => r.netCagrPct);
  const dds = rows.map((r) => -Math.abs(r.maxDrawdownPct));
  const positiveRate = cagrs.filter((c) => c > 0).length / rows.length;
  const drawdownStable = dds.every((d) => Math.abs(d) <= g.maxDrawdownPct + 1e-9);
  const medianNetCagrPct = median(cagrs);
  return {
    regime,
    windows: rows.length,
    bars: rows.reduce((sum, r) => sum + (r.window.testEnd - r.window.testStart), 0),
    medianNetCagrPct,
    meanNetCagrPct: cagrs.reduce((a, b) => a + b, 0) / rows.length,
    worstNetCagrPct: Math.min(...cagrs),
    bestNetCagrPct: Math.max(...cagrs),
    cagrStdPct: stdev(cagrs),
    medianMaxDrawdownPct: median(dds),
    worstMaxDrawdownPct: Math.min(...dds),
    medianBenchmarkCagrPct: median(rows.map((r) => r.benchmarkCagrPct)),
    positiveRate,
    beatBenchmarkRate: rows.filter((r) => r.netCagrPct > r.benchmarkCagrPct).length / rows.length,
    medianTradesPerYear: median(rows.map((r) => r.tradesPerYear)),
    drawdownStable,
    pass:
      drawdownStable
      && medianNetCagrPct >= g.minMedianCagrPct - 1e-9
      && positiveRate >= g.minPositiveRate - 1e-9,
  };
}

export type RegimeReport = {
  summaries: RegimeSummary[];
  /** Regimes with at least one out-of-sample window. */
  covered: RegimeLabel[];
  /** Regimes that failed the gate. */
  failed: RegimeLabel[];
  /** Spread between the best and worst regime median CAGR, in points. */
  cagrDispersionPct: number;
  /** Worst drawdown seen in any window, any regime. */
  worstDrawdownPct: number;
  verdict: "stable" | "regime-dependent" | "unstable";
};

export function buildRegimeReport(
  results: readonly WindowResult[],
  gate: Partial<RegimeGate> = {},
): RegimeReport {
  const summaries = REGIMES.map((r) => summariseRegime(r, results, gate));
  const covered = summaries.filter((s) => s.windows > 0).map((s) => s.regime);
  const scored = summaries.filter((s) => s.windows > 0);
  const failed = scored.filter((s) => !s.pass).map((s) => s.regime);
  const medians = scored.map((s) => s.medianNetCagrPct);
  const dispersion = medians.length ? Math.max(...medians) - Math.min(...medians) : 0;
  const worstDrawdownPct = results.length
    ? Math.min(...results.map((r) => -Math.abs(r.maxDrawdownPct)))
    : 0;
  const verdict: RegimeReport["verdict"] =
    failed.length === 0 ? "stable" : failed.length < scored.length ? "regime-dependent" : "unstable";
  return { summaries, covered, failed, cagrDispersionPct: dispersion, worstDrawdownPct, verdict };
}

// ---------------------------------------------------------------- output

export const REGIME_COLUMNS = [
  "regime",
  "windows",
  "median CAGR %",
  "worst CAGR %",
  "CAGR sd",
  "median maxDD %",
  "worst maxDD %",
  "bench CAGR %",
  "profitable",
  "beat B&H",
  "trades/yr",
  "result",
] as const;

export const WINDOW_COLUMNS = [
  "#",
  "from",
  "to",
  "regime",
  "purity",
  "net CAGR %",
  "maxDD %",
  "bench CAGR %",
  "trades/yr",
  "fees %",
] as const;

const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "-");
const pctOf = (v: number) => `${Math.round(v * 100)}%`;

export function regimeTableRows(summaries: readonly RegimeSummary[]): string[][] {
  return summaries.map((s) => [
    s.regime,
    String(s.windows),
    f(s.medianNetCagrPct),
    f(s.worstNetCagrPct),
    f(s.cagrStdPct),
    f(s.medianMaxDrawdownPct),
    f(s.worstMaxDrawdownPct),
    f(s.medianBenchmarkCagrPct),
    pctOf(s.positiveRate),
    pctOf(s.beatBenchmarkRate),
    f(s.medianTradesPerYear, 0),
    s.windows === 0 ? "no data" : s.pass ? "pass" : s.drawdownStable ? "weak returns" : "drawdown breach",
  ]);
}

export function windowTableRows(results: readonly WindowResult[]): string[][] {
  return results.map((r) => [
    String(r.window.index),
    r.from,
    r.to,
    r.regime,
    pctOf(r.purity),
    f(r.netCagrPct),
    f(-Math.abs(r.maxDrawdownPct)),
    f(r.benchmarkCagrPct),
    f(r.tradesPerYear, 0),
    f(r.feeDragPct),
  ]);
}

function pad(rows: readonly string[][], columns: readonly string[]): string {
  const all = [[...columns], ...rows];
  const widths = columns.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  return all.map((r) => r.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ")).join("\n");
}

export function formatRegimeTable(summaries: readonly RegimeSummary[]): string {
  return pad(regimeTableRows(summaries), REGIME_COLUMNS);
}

export function formatWindowTable(results: readonly WindowResult[]): string {
  return pad(windowTableRows(results), WINDOW_COLUMNS);
}

export function summariseReport(report: RegimeReport, gate: Partial<RegimeGate> = {}): string {
  const g = { ...DEFAULT_REGIME_GATE, ...gate };
  const head = `Regime verdict: ${report.verdict}`;
  const cover = ` — covered ${report.covered.join(", ") || "nothing"}`;
  const fail = report.failed.length ? `; failed in ${report.failed.join(", ")}` : "; all regimes pass";
  const nums =
    `; median CAGR spread ${f(report.cagrDispersionPct)}pts, ` +
    `worst drawdown ${f(report.worstDrawdownPct)}% against a -${g.maxDrawdownPct}% ceiling`;
  return head + cover + fail + nums;
}
