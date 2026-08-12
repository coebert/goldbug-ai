// Pure computation behind the multi-symbol overlay on the drill-down chart.
//
// Each symbol has its own price scale (index points, dollars, GBX), so the
// only honest way to draw them together is to rebase every series to 100 at
// the first date where *all* selected symbols have a close. Rebasing to a
// shared start also makes the "range change" column comparable: it is the
// move over exactly the same window for every row.

import { CHART_SEQUENCE } from "./chart-palette";
import { smaKey, type SmaPeriod, type SymbolHistory } from "./market-symbol-history";

/** Hard cap on overlays: beyond this the chart stops being readable. */
export const MAX_COMPARE_SYMBOLS = 4;

export interface ComparePoint {
  date: string;
  /** symbol -> value rebased to 100 at the shared start date. */
  [symbol: string]: string | number | null;
}

export interface CompareSeries {
  symbol: string;
  label: string;
  kind: string;
  color: string;
  /** % change over the shared window (not each series' own window). */
  changePct: number | null;
  /** Highest/lowest rebased value inside the shared window. */
  peakPct: number | null;
  troughPct: number | null;
  volatilityPct: number | null;
  maxDrawdownPct: number | null;
  last: number | null;
}

/** One rebased moving-average line drawn alongside a symbol's price line. */
export interface CompareSmaSeries {
  /** Data key on each ComparePoint, e.g. "AAPL~sma50". */
  key: string;
  symbol: string;
  period: SmaPeriod;
  label: string;
  color: string;
}

/** Data key for a symbol's raw (unrebased) close. */
export function comparePriceKey(symbol: string): string {
  return `${symbol}~price`;
}

/** Data key for a symbol's raw (unrebased) moving average. */
export function compareSmaPriceKey(symbol: string, period: SmaPeriod): string {
  return `${symbol}~sma${period}~price`;
}

/** Data key for a symbol's 14-day RSI (its own 0-100 scale). */
export function compareRsiKey(symbol: string): string {
  return `${symbol}~rsi`;
}

/** Data key for a symbol's rebased moving average. */
export function compareSmaKey(symbol: string, period: SmaPeriod): string {
  return `${symbol}~sma${period}`;
}

export interface CorrelationCell {
  /** Pearson correlation of daily returns, or null when too few points. */
  value: number | null;
  /** Number of overlapping return observations behind `value`. */
  n: number;
}

export interface CorrelationMatrix {
  symbols: string[];
  labels: string[];
  /** Row-major matrix aligned to `symbols`; diagonal is 1. */
  cells: CorrelationCell[][];
  /** Return observations available in the shared window. */
  observations: number;
}

/** Minimum overlapping daily returns before a correlation is worth showing. */
export const MIN_CORRELATION_POINTS = 10;

export interface Comparison {
  /** Dates common to every selected symbol, ascending. */
  dates: string[];
  points: ComparePoint[];
  series: CompareSeries[];
  /** Rebased moving-average lines, empty unless periods were requested. */
  smaSeries: CompareSmaSeries[];
  from: string | null;
  to: string | null;
  /** Return correlations between every selected symbol over the shared window. */
  correlation: CorrelationMatrix;
  /** Daily returns aligned to `dates` per symbol, for rolling-window analysis. */
  returns: Record<string, (number | null)[]>;
}

/** Selectable rolling-correlation windows, in trading-day observations. */
export const ROLLING_WINDOWS = [30, 60, 90] as const;
export type RollingWindow = (typeof ROLLING_WINDOWS)[number];

export interface RollingPair {
  /** Stable key, e.g. "SPY|QQQ". */
  key: string;
  symbolA: string;
  symbolB: string;
  label: string;
  color: string;
  /** Correlation at each date in `dates`; null before the window fills. */
  values: (number | null)[];
  latest: number | null;
  min: number | null;
  max: number | null;
  average: number | null;
}

export interface RollingCorrelation {
  window: RollingWindow;
  /** Dates carrying at least one computed pair value, ascending. */
  dates: string[];
  pairs: RollingPair[];
}

/** Parse the `compare` search param (comma separated) into a clean list. */
export function parseCompareParam(value: unknown, exclude?: string): string[] {
  const raw =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value.map((v) => String(v))
        : [];
  const out: string[] = [];
  for (const item of raw) {
    const s = item.trim();
    if (!s || s === exclude || out.includes(s)) continue;
    out.push(s);
    if (out.length >= MAX_COMPARE_SYMBOLS) break;
  }
  return out;
}

export function serialiseCompareParam(symbols: string[]): string | undefined {
  const list = symbols.filter(Boolean).slice(0, MAX_COMPARE_SYMBOLS);
  return list.length ? list.join(",") : undefined;
}

/** Toggle a symbol in/out of the overlay list, respecting the cap. */
export function toggleCompareSymbol(current: string[], symbol: string): string[] {
  if (current.includes(symbol)) return current.filter((s) => s !== symbol);
  if (current.length >= MAX_COMPARE_SYMBOLS) return current;
  return [...current, symbol];
}

function pearson(a: (number | null)[], b: (number | null)[]): CorrelationCell {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < a.length && i < b.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x);
    ys.push(y);
  }
  const n = xs.length;
  if (n < MIN_CORRELATION_POINTS) return { value: null, n };

  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return { value: null, n };
  const r = cov / Math.sqrt(vx * vy);
  return { value: Math.max(-1, Math.min(1, Number(r.toFixed(4)))), n };
}

/**
 * Correlation of daily returns between every pair, computed only on dates
 * where both symbols moved — a flat/missing day is dropped rather than
 * counted as a zero return, which would bias correlations toward zero.
 */
export function buildCorrelationMatrix(
  symbols: string[],
  labels: string[],
  returnsBySymbol: Map<string, (number | null)[]>,
): CorrelationMatrix {
  const cells = symbols.map((rowSym) =>
    symbols.map((colSym) => {
      if (rowSym === colSym) {
        const own = (returnsBySymbol.get(rowSym) ?? []).filter(
          (v) => v != null && Number.isFinite(v),
        );
        return { value: own.length >= MIN_CORRELATION_POINTS ? 1 : null, n: own.length };
      }
      return pearson(returnsBySymbol.get(rowSym) ?? [], returnsBySymbol.get(colSym) ?? []);
    }),
  );

  let observations = 0;
  for (const s of symbols) {
    const n = (returnsBySymbol.get(s) ?? []).filter((v) => v != null).length;
    observations = Math.max(observations, n);
  }

  return { symbols, labels, cells, observations };
}

/** Result of reordering a correlation matrix by similarity. */
export interface ClusteredCorrelation {
  /** The same matrix with rows/columns reordered so similar markets sit together. */
  matrix: CorrelationMatrix;
  /** Original index of each symbol, in the new display order. */
  order: number[];
  /** Cluster id per display position; equal ids move together. */
  groups: number[];
}

/** Pairs closer than this correlation distance (1 - r) count as one cluster. */
const CLUSTER_CUT_DISTANCE = 0.5;

function distanceOf(cells: CorrelationCell[][], a: number, b: number): number {
  const v = cells[a]?.[b]?.value;
  // Unmeasurable pairs are treated as unrelated rather than opposed.
  return v == null ? 1 : 1 - v;
}

/**
 * Average-linkage hierarchical clustering on correlation distance (1 - r).
 * Returns a leaf ordering that puts co-moving markets next to each other, so
 * blocks of green/red in the heatmap read as groups instead of scatter.
 */
export function clusterCorrelation(correlation: CorrelationMatrix): ClusteredCorrelation {
  const { symbols, labels, cells, observations } = correlation;
  const n = symbols.length;
  if (n < 3) {
    return {
      matrix: correlation,
      order: symbols.map((_, i) => i),
      groups: symbols.map(() => 0),
    };
  }

  // Each cluster keeps its members in leaf order; merges concatenate them.
  let clusters = symbols.map((_, i) => ({ members: [i], height: 0 }));

  const avgDistance = (a: number[], b: number[]) => {
    let total = 0;
    for (const i of a) for (const j of b) total += distanceOf(cells, i, j);
    return total / (a.length * b.length);
  };

  while (clusters.length > 1) {
    let best = { a: 0, b: 1, d: Infinity };
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        const d = avgDistance(clusters[a].members, clusters[b].members);
        if (d < best.d) best = { a, b, d };
      }
    }
    const merged = {
      members: [...clusters[best.a].members, ...clusters[best.b].members],
      height: best.d,
    };
    clusters = clusters.filter((_, i) => i !== best.a && i !== best.b);
    clusters.push(merged);
  }

  const order = clusters[0].members;

  // Cut the ordering into groups wherever adjacent markets are far apart.
  const groups: number[] = [];
  let group = 0;
  order.forEach((idx, pos) => {
    if (pos > 0 && distanceOf(cells, order[pos - 1], idx) > CLUSTER_CUT_DISTANCE) group++;
    groups.push(group);
  });

  return {
    matrix: {
      symbols: order.map((i) => symbols[i]),
      labels: order.map((i) => labels[i]),
      cells: order.map((i) => order.map((j) => cells[i][j])),
      observations,
    },
    order,
    groups,
  };
}

function intersectDates(histories: SymbolHistory[]): string[] {
  if (!histories.length) return [];
  let common: string[] = histories[0].points.map((p) => p.date);
  for (let i = 1; i < histories.length; i++) {
    const set = new Set(histories[i].points.map((p) => p.date));
    common = common.filter((d) => set.has(d));
  }
  return common;
}

/**
 * Build the overlay chart rows and the side-by-side stats.
 * `histories[0]` is treated as the page's primary symbol and drawn first.
 */
export function buildComparison(
  histories: SymbolHistory[],
  smaPeriods: readonly SmaPeriod[] = [],
): Comparison {
  const usable = histories.filter((h) => h && h.points.length >= 2);
  const dates = intersectDates(usable);

  if (dates.length < 2) {
    return {
      dates: [],
      points: [],
      series: [],
      smaSeries: [],
      from: null,
      to: null,
      correlation: { symbols: [], labels: [], cells: [], observations: 0 },
      returns: {},
    };
  }

  const dateSet = new Set(dates);
  const points: ComparePoint[] = dates.map((date) => ({ date }) as ComparePoint);
  const index = new Map(dates.map((d, i) => [d, i]));
  const series: CompareSeries[] = [];
  const smaSeries: CompareSmaSeries[] = [];
  // symbol -> daily returns aligned to `dates` (index 0 has no prior close).
  const returnsBySymbol = new Map<string, (number | null)[]>();

  usable.forEach((h, i) => {
    const rows = h.points.filter((p) => dateSet.has(p.date));
    const base = rows[0]?.close ?? null;
    if (!base || base <= 0) return;

    let peak = -Infinity;
    let trough = Infinity;
    let runningPeak = 0;
    let maxDd: number | null = null;
    const rets: number[] = [];
    const aligned: (number | null)[] = dates.map(() => null);

    for (let j = 0; j < rows.length; j++) {
      const close = rows[j].close;
      const rebased = Number(((close / base) * 100).toFixed(3));
      const at = index.get(rows[j].date);
      if (at != null) {
        points[at][h.symbol] = rebased;
        points[at][comparePriceKey(h.symbol)] = close;
      }

      peak = Math.max(peak, rebased);
      trough = Math.min(trough, rebased);
      runningPeak = Math.max(runningPeak, close);
      if (runningPeak > 0) {
        const dd = ((close - runningPeak) / runningPeak) * 100;
        maxDd = maxDd == null ? dd : Math.min(maxDd, dd);
      }
      if (j > 0 && rows[j - 1].close > 0) {
        const ret = close / rows[j - 1].close - 1;
        rets.push(ret);
        if (at != null) aligned[at] = ret;
      }
    }

    // Moving averages share the symbol's rebasing factor, so they stay in the
    // same 100-based space as its price line and remain directly comparable.
    for (const period of smaPeriods) {
      let any = false;
      for (const p of h.points) {
        const at = index.get(p.date);
        if (at == null) continue;
        const v = p[smaKey(period)];
        if (v == null || !Number.isFinite(v)) continue;
        points[at][compareSmaKey(h.symbol, period)] = Number(((v / base) * 100).toFixed(3));
        points[at][compareSmaPriceKey(h.symbol, period)] = v;
        any = true;
      }
      if (any) {
        smaSeries.push({
          key: compareSmaKey(h.symbol, period),
          symbol: h.symbol,
          period,
          label: `${h.label} SMA${period}`,
          color: CHART_SEQUENCE[i % CHART_SEQUENCE.length],
        });
      }
    }

    // RSI is scale-free (0-100), so it is carried through unrebased.
    for (const p of h.points) {
      const at = index.get(p.date);
      if (at == null) continue;
      const r = p.rsi14;
      if (r == null || !Number.isFinite(r)) continue;
      points[at][compareRsiKey(h.symbol)] = r;
    }

    returnsBySymbol.set(h.symbol, aligned);

    let volatilityPct: number | null = null;
    if (rets.length >= 5) {
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
      volatilityPct = Math.sqrt(variance) * Math.sqrt(252) * 100;
    }

    const last = rows[rows.length - 1]?.close ?? null;

    series.push({
      symbol: h.symbol,
      label: h.label,
      kind: h.kind,
      color: CHART_SEQUENCE[i % CHART_SEQUENCE.length],
      changePct: last != null ? ((last - base) / base) * 100 : null,
      peakPct: Number.isFinite(peak) ? peak - 100 : null,
      troughPct: Number.isFinite(trough) ? trough - 100 : null,
      volatilityPct,
      maxDrawdownPct: maxDd,
      last,
    });
  });

  return {
    dates,
    points,
    series,
    smaSeries,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    correlation: buildCorrelationMatrix(
      series.map((s) => s.symbol),
      series.map((s) => s.label),
      returnsBySymbol,
    ),
    returns: Object.fromEntries(returnsBySymbol),
  };
}

/**
 * Rolling Pearson correlation for every symbol pair: at each date, correlate
 * the last `window` overlapping daily returns. This exposes *changes* in the
 * relationship (e.g. a hedge that stops hedging in a selloff) that a single
 * full-window number averages away.
 *
 * A date only gets a value once the trailing slice holds at least
 * `MIN_CORRELATION_POINTS` overlapping observations, so early points are left
 * blank rather than computed from a handful of days.
 */
export function buildRollingCorrelation(
  comparison: Comparison,
  window: RollingWindow,
): RollingCorrelation {
  const { dates, series, returns } = comparison;
  const pairs: RollingPair[] = [];

  let colorIndex = 0;
  for (let a = 0; a < series.length; a++) {
    for (let b = a + 1; b < series.length; b++) {
      const sa = series[a];
      const sb = series[b];
      const ra = returns[sa.symbol] ?? [];
      const rb = returns[sb.symbol] ?? [];

      const values: (number | null)[] = dates.map((_, i) => {
        const start = Math.max(0, i - window + 1);
        const { value, n } = pearson(ra.slice(start, i + 1), rb.slice(start, i + 1));
        return n >= MIN_CORRELATION_POINTS ? value : null;
      });

      const present = values.filter((v): v is number => v != null);
      pairs.push({
        key: `${sa.symbol}|${sb.symbol}`,
        symbolA: sa.symbol,
        symbolB: sb.symbol,
        label: `${sa.label} · ${sb.label}`,
        color: CHART_SEQUENCE[colorIndex++ % CHART_SEQUENCE.length],
        values,
        latest: present.length ? present[present.length - 1] : null,
        min: present.length ? Math.min(...present) : null,
        max: present.length ? Math.max(...present) : null,
        average: present.length
          ? Number((present.reduce((x, y) => x + y, 0) / present.length).toFixed(4))
          : null,
      });
    }
  }

  const firstIndex = dates.findIndex((_, i) => pairs.some((p) => p.values[i] != null));
  const trimFrom = firstIndex < 0 ? dates.length : firstIndex;

  return {
    window,
    dates: dates.slice(trimFrom),
    pairs: pairs.map((p) => ({ ...p, values: p.values.slice(trimFrom) })),
  };
}
