// Pure computation behind the Market pulse drill-down page.
//
// Takes raw daily closes for one symbol out of `price_cache` and produces the
// window the chart draws plus the summary stats above it. Percentage moves are
// unit-agnostic (close ÷ close), so GBX-quoted LSE symbols need no scaling.

import { PULSE_COMPARISON, PULSE_INSTRUMENTS, PULSE_SECTORS, type PriceRow } from "./market-pulse";

/** Selectable time ranges on the drill-down page, in calendar days. */
export const HISTORY_RANGES = [30, 90, 180, 365, 1095] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];
export const DEFAULT_RANGE: HistoryRange = 90;

export function rangeLabel(days: number): string {
  if (days >= 365 && days % 365 === 0) return `${days / 365}y`;
  return `${days}d`;
}

export function isHistoryRange(v: unknown): v is HistoryRange {
  return typeof v === "number" && (HISTORY_RANGES as readonly number[]).includes(v);
}

export function coerceRange(v: unknown): HistoryRange {
  const n = typeof v === "string" ? Number(v) : v;
  return isHistoryRange(n) ? n : DEFAULT_RANGE;
}

export interface SymbolMeta {
  symbol: string;
  label: string;
  /** Extra context line, e.g. "US sector" or "Volatility". */
  kind: string;
}

const META: Map<string, SymbolMeta> = new Map();
for (const i of PULSE_INSTRUMENTS) {
  META.set(i.symbol, { symbol: i.symbol, label: i.label, kind: "Market" });
}
for (const s of PULSE_SECTORS) {
  if (!META.has(s.symbol)) META.set(s.symbol, { symbol: s.symbol, label: s.label, kind: "US sector" });
}
for (const c of PULSE_COMPARISON) {
  if (!META.has(c.symbol)) META.set(c.symbol, { symbol: c.symbol, label: c.label, kind: "Market" });
}

/** Symbols the drill-down page is allowed to chart. */
export const HISTORY_SYMBOLS: string[] = [...META.keys()];

export function symbolMeta(symbol: string): SymbolMeta | null {
  return META.get(symbol) ?? null;
}

export function isKnownSymbol(symbol: string): boolean {
  return META.has(symbol);
}

/** Simple-moving-average periods available on charts, in trading days. */
export const SMA_PERIODS = [20, 50, 100, 200] as const;
export type SmaPeriod = (typeof SMA_PERIODS)[number];

/** Chart series key for a period, e.g. 50 -> "sma50". */
export function smaKey(period: SmaPeriod): `sma${SmaPeriod}` {
  return `sma${period}` as `sma${SmaPeriod}`;
}

export function isSmaPeriod(value: number): value is SmaPeriod {
  return (SMA_PERIODS as readonly number[]).includes(value);
}

export interface HistoryPoint {
  date: string;
  close: number;
  /** Indexed to 100 at the start of the selected window. */
  indexed: number;
  sma20: number | null;
  sma50: number | null;
  sma100: number | null;
  sma200: number | null;
}

export interface SymbolHistory {
  symbol: string;
  label: string;
  kind: string;
  days: number;
  points: HistoryPoint[];
  last: number | null;
  asOf: string | null;
  changePct: number | null;
  changeAbs: number | null;
  high: number | null;
  low: number | null;
  /** Annualised standard deviation of daily returns, in %. */
  volatilityPct: number | null;
  /** Worst peak-to-trough fall inside the window, in %. */
  maxDrawdownPct: number | null;
  sma50: number | null;
  sma200: number | null;
  aboveSma50: boolean | null;
  aboveSma200: boolean | null;
  /** Latest value of every supported average, keyed by period. */
  smaLatest: Record<SmaPeriod, number | null>;
  /** Whether the last close sits above each average; null when unavailable. */
  aboveSma: Record<SmaPeriod, boolean | null>;
}

function cleanSorted(rows: PriceRow[]): PriceRow[] {
  return rows
    .filter((r) => r && Number.isFinite(r.close) && r.close > 0)
    .slice()
    .sort((a, b) => a.price_date.localeCompare(b.price_date));
}

function trailingAverage(values: number[], endIndex: number, window: number): number | null {
  if (endIndex + 1 < window) return null;
  let sum = 0;
  for (let i = endIndex - window + 1; i <= endIndex; i++) sum += values[i];
  return sum / window;
}

/**
 * Build the chart window. `rows` should include extra history before the
 * window so the 50/200-day averages are populated from the first point.
 */
export function buildSymbolHistory(
  symbol: string,
  rows: PriceRow[],
  days: number,
): SymbolHistory {
  const meta = symbolMeta(symbol);
  const all = cleanSorted(rows);
  const closes = all.map((r) => r.close);

  // Calendar-day cut so "90d" means 90 days of tape, not 90 sessions.
  const cutoff = all.length
    ? new Date(new Date(`${all[all.length - 1].price_date}T00:00:00Z`).getTime() - days * 86_400_000)
        .toISOString()
        .slice(0, 10)
    : null;
  const startIdx = cutoff ? all.findIndex((r) => r.price_date >= cutoff) : -1;
  const from = startIdx >= 0 ? startIdx : 0;

  const points: HistoryPoint[] = [];
  const base = all[from]?.close ?? null;
  for (let i = from; i < all.length; i++) {
    points.push({
      date: all[i].price_date,
      close: all[i].close,
      indexed: base && base > 0 ? Number(((all[i].close / base) * 100).toFixed(3)) : 100,
      sma20: trailingAverage(closes, i, 20),
      sma50: trailingAverage(closes, i, 50),
      sma100: trailingAverage(closes, i, 100),
      sma200: trailingAverage(closes, i, 200),
    });
  }

  const last = points.length ? points[points.length - 1].close : null;
  const first = points.length ? points[0].close : null;

  let high: number | null = null;
  let low: number | null = null;
  let peak = 0;
  let maxDd: number | null = null;
  const rets: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const c = points[i].close;
    high = high == null ? c : Math.max(high, c);
    low = low == null ? c : Math.min(low, c);
    peak = Math.max(peak, c);
    if (peak > 0) {
      const dd = ((c - peak) / peak) * 100;
      maxDd = maxDd == null ? dd : Math.min(maxDd, dd);
    }
    if (i > 0) {
      const prev = points[i - 1].close;
      if (prev > 0) rets.push(c / prev - 1);
    }
  }

  let volatilityPct: number | null = null;
  if (rets.length >= 5) {
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
    volatilityPct = Math.sqrt(variance) * Math.sqrt(252) * 100;
  }

  const lastPoint = points.length ? points[points.length - 1] : null;

  return {
    symbol,
    label: meta?.label ?? symbol,
    kind: meta?.kind ?? "Market",
    days,
    points,
    last,
    asOf: lastPoint?.date ?? null,
    changePct: first && first > 0 && last != null ? ((last - first) / first) * 100 : null,
    changeAbs: first != null && last != null ? last - first : null,
    high,
    low,
    volatilityPct,
    maxDrawdownPct: maxDd,
    sma50: lastPoint?.sma50 ?? null,
    sma200: lastPoint?.sma200 ?? null,
    aboveSma50: lastPoint?.sma50 != null && last != null ? last > lastPoint.sma50 : null,
    aboveSma200: lastPoint?.sma200 != null && last != null ? last > lastPoint.sma200 : null,
    smaLatest: Object.fromEntries(
      SMA_PERIODS.map((p) => [p, lastPoint?.[smaKey(p)] ?? null]),
    ) as Record<SmaPeriod, number | null>,
    aboveSma: Object.fromEntries(
      SMA_PERIODS.map((p) => {
        const avg = lastPoint?.[smaKey(p)] ?? null;
        return [p, avg != null && last != null ? last > avg : null];
      }),
    ) as Record<SmaPeriod, boolean | null>,
  };
}

/**
 * A moment where a faster average crossed a slower one inside the window.
 * "golden" = fast crossed above slow (bullish), "death" = fast crossed below.
 */
export interface SmaCrossover {
  /** Stable key for React lists. */
  id: string;
  date: string;
  fast: SmaPeriod;
  slow: SmaPeriod;
  direction: "golden" | "death";
  /** Close on the crossover bar — used to place the chart marker. */
  close: number;
  /** Average value where the two lines met. */
  level: number;
  /** Sessions since the crossover (0 = latest bar). */
  barsAgo: number;
  /** Price change from the crossover bar to the last bar, in %. */
  sinceChangePct: number | null;
}

export function crossoverLabel(c: SmaCrossover): string {
  const kind = c.direction === "golden" ? "crossed above" : "crossed below";
  return `${c.fast}d ${kind} ${c.slow}d`;
}

/**
 * Detect crossovers between every adjacent pair of the selected periods
 * (e.g. [20,50,200] -> 20/50 and 50/200), newest first.
 */
export function detectSmaCrossovers(
  points: HistoryPoint[],
  periods: readonly SmaPeriod[],
): SmaCrossover[] {
  const ordered = SMA_PERIODS.filter((p) => periods.includes(p));
  if (ordered.length < 2 || points.length < 2) return [];

  const last = points[points.length - 1];
  const out: SmaCrossover[] = [];

  for (let k = 0; k + 1 < ordered.length; k++) {
    const fast = ordered[k];
    const slow = ordered[k + 1];
    for (let i = 1; i < points.length; i++) {
      const prevFast = points[i - 1][smaKey(fast)];
      const prevSlow = points[i - 1][smaKey(slow)];
      const curFast = points[i][smaKey(fast)];
      const curSlow = points[i][smaKey(slow)];
      if (prevFast == null || prevSlow == null || curFast == null || curSlow == null) continue;

      const prevDiff = prevFast - prevSlow;
      const diff = curFast - curSlow;
      if (prevDiff === 0 || diff === 0) continue;
      if (prevDiff > 0 === diff > 0) continue;

      out.push({
        id: `${fast}-${slow}-${points[i].date}`,
        date: points[i].date,
        fast,
        slow,
        direction: diff > 0 ? "golden" : "death",
        close: points[i].close,
        level: (curFast + curSlow) / 2,
        barsAgo: points.length - 1 - i,
        sinceChangePct:
          points[i].close > 0 ? ((last.close - points[i].close) / points[i].close) * 100 : null,
      });
    }
  }

  return out.sort((a, b) => (a.date === b.date ? a.fast - b.fast : b.date.localeCompare(a.date)));
}

/**
 * Trend strength = how fast the trend average is rising relative to how noisy
 * the price is. It is the slope of a least-squares fit through log(SMA),
 * annualised, divided by annualised return volatility — i.e. a "trend Sharpe".
 * Scaled to a readable -100..+100 score (±25 raw = ±100).
 */
export interface TrendStrength {
  /** Period whose average the slope was measured on (slowest selected). */
  period: SmaPeriod;
  /** Annualised log-slope of the average, in % per year. */
  slopeAnnualPct: number;
  /** Annualised volatility of daily returns, in %. */
  volatilityPct: number;
  /** slopeAnnual / volatility, unitless. */
  ratio: number;
  /** Clamped -100..+100 presentation score. */
  score: number;
  direction: "up" | "down" | "flat";
  label: string;
  /** Bars used in the fit. */
  samples: number;
}

function strengthLabel(score: number): { label: string; direction: "up" | "down" | "flat" } {
  const a = Math.abs(score);
  if (a < 10) return { label: "Flat / no trend", direction: "flat" };
  const dir = score > 0 ? "up" : "down";
  const word = score > 0 ? "uptrend" : "downtrend";
  if (a >= 70) return { label: `Very strong ${word}`, direction: dir };
  if (a >= 40) return { label: `Strong ${word}`, direction: dir };
  if (a >= 20) return { label: `Moderate ${word}`, direction: dir };
  return { label: `Weak ${word}`, direction: dir };
}

export function computeTrendStrength(
  points: HistoryPoint[],
  periods: readonly SmaPeriod[],
  /** Explicit basis average; defaults to the slowest selected period. */
  basis?: SmaPeriod | null,
): TrendStrength | null {
  const ordered = SMA_PERIODS.filter((p) => periods.includes(p));
  const period = basis && isSmaPeriod(basis) ? basis : ordered[ordered.length - 1];
  if (!period || points.length < 10) return null;

  // Slope of the trend average, in log space so it reads as % per unit time.
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const v = points[i][smaKey(period)];
    if (v == null || v <= 0) continue;
    xs.push(i);
    ys.push(Math.log(v));
  }
  if (xs.length < 10) return null;

  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return null;
  const slopePerBar = num / den;
  const slopeAnnualPct = slopePerBar * 252 * 100;

  // Annualised volatility of daily closes over the same window.
  const rets: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].close;
    if (prev > 0) rets.push(points[i].close / prev - 1);
  }
  if (rets.length < 5) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const volatilityPct = Math.sqrt(variance) * Math.sqrt(252) * 100;
  if (!(volatilityPct > 0)) return null;

  const ratio = slopeAnnualPct / volatilityPct;
  const score = Math.max(-100, Math.min(100, Math.round(ratio * 25)));
  const { label, direction } = strengthLabel(score);

  return { period, slopeAnnualPct, volatilityPct, ratio, score, direction, label, samples: n };
}

export interface TrendStrengthPoint {
  date: string;
  score: number;
}

/**
 * Rolling trend-strength score: re-runs `computeTrendStrength` over a trailing
 * window at each bar so the score can be drawn as a sparkline.
 */
export function computeTrendStrengthSeries(
  points: HistoryPoint[],
  periods: readonly SmaPeriod[],
  window = 30,
  basis?: SmaPeriod | null,
): TrendStrengthPoint[] {
  const w = Math.max(10, Math.min(window, points.length));
  if (points.length < w) return [];
  const out: TrendStrengthPoint[] = [];
  for (let end = w; end <= points.length; end++) {
    const slice = points.slice(end - w, end);
    const s = computeTrendStrength(slice, periods, basis);
    if (s) out.push({ date: slice[slice.length - 1].date, score: s.score });
  }
  return out;
}
