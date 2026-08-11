// Pure computation behind the multi-symbol overlay on the drill-down chart.
//
// Each symbol has its own price scale (index points, dollars, GBX), so the
// only honest way to draw them together is to rebase every series to 100 at
// the first date where *all* selected symbols have a close. Rebasing to a
// shared start also makes the "range change" column comparable: it is the
// move over exactly the same window for every row.

import { CHART_SEQUENCE } from "./chart-palette";
import type { SymbolHistory } from "./market-symbol-history";

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

export interface Comparison {
  /** Dates common to every selected symbol, ascending. */
  dates: string[];
  points: ComparePoint[];
  series: CompareSeries[];
  from: string | null;
  to: string | null;
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
export function buildComparison(histories: SymbolHistory[]): Comparison {
  const usable = histories.filter((h) => h && h.points.length >= 2);
  const dates = intersectDates(usable);

  if (dates.length < 2) {
    return { dates: [], points: [], series: [], from: null, to: null };
  }

  const dateSet = new Set(dates);
  const points: ComparePoint[] = dates.map((date) => ({ date }) as ComparePoint);
  const index = new Map(dates.map((d, i) => [d, i]));
  const series: CompareSeries[] = [];

  usable.forEach((h, i) => {
    const rows = h.points.filter((p) => dateSet.has(p.date));
    const base = rows[0]?.close ?? null;
    if (!base || base <= 0) return;

    let peak = -Infinity;
    let trough = Infinity;
    let runningPeak = 0;
    let maxDd: number | null = null;
    const rets: number[] = [];

    for (let j = 0; j < rows.length; j++) {
      const close = rows[j].close;
      const rebased = Number(((close / base) * 100).toFixed(3));
      const at = index.get(rows[j].date);
      if (at != null) points[at][h.symbol] = rebased;

      peak = Math.max(peak, rebased);
      trough = Math.min(trough, rebased);
      runningPeak = Math.max(runningPeak, close);
      if (runningPeak > 0) {
        const dd = ((close - runningPeak) / runningPeak) * 100;
        maxDd = maxDd == null ? dd : Math.min(maxDd, dd);
      }
      if (j > 0 && rows[j - 1].close > 0) rets.push(close / rows[j - 1].close - 1);
    }

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
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
  };
}
