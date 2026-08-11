// Shared presentation settings for moving-average overlays.
//
// The home dashboard card and the full-chart page must show the same lines,
// so the selected periods live under one localStorage key and the stroke
// styling comes from one table.

import { CHART_ROLE } from "./chart-palette";
import { SMA_PERIODS, isSmaPeriod, type SmaPeriod } from "./market-symbol-history";

/** Shared with the home card so both views agree on the chosen averages. */
export const SMA_PERIODS_KEY = "home-sma-periods";

export const DEFAULT_SMA_PERIODS: SmaPeriod[] = [50, 200];

/** One stroke style per period so overlapping averages stay distinguishable. */
export const PERIOD_STYLE: Record<SmaPeriod, { stroke: string; dash: string }> = {
  20: { stroke: CHART_ROLE.positive, dash: "6 2" },
  50: { stroke: CHART_ROLE.benchmark, dash: "4 3" },
  100: { stroke: CHART_ROLE.warning, dash: "1 3" },
  200: { stroke: CHART_ROLE.highlight, dash: "2 4" },
};

/** Parse a stored/serialised "50,200" list; falls back to the default pair. */
export function parseSmaPeriods(raw: string | null | undefined): SmaPeriod[] {
  if (!raw) return DEFAULT_SMA_PERIODS;
  const picked = String(raw)
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && isSmaPeriod(v)) as SmaPeriod[];
  const ordered = SMA_PERIODS.filter((p) => picked.includes(p));
  return ordered.length ? ordered : DEFAULT_SMA_PERIODS;
}

export function serialiseSmaPeriods(periods: readonly SmaPeriod[]): string {
  return SMA_PERIODS.filter((p) => periods.includes(p)).join(",");
}

export function readStoredSmaPeriods(): SmaPeriod[] {
  try {
    return parseSmaPeriods(window.localStorage.getItem(SMA_PERIODS_KEY));
  } catch {
    return DEFAULT_SMA_PERIODS;
  }
}

export function storeSmaPeriods(periods: readonly SmaPeriod[]): void {
  try {
    window.localStorage.setItem(SMA_PERIODS_KEY, serialiseSmaPeriods(periods));
  } catch {
    /* storage unavailable — in-memory selection still works */
  }
}

/** Toggle one period, never leaving the chart with zero averages. */
export function toggleSmaPeriod(
  current: readonly SmaPeriod[],
  period: SmaPeriod,
): SmaPeriod[] {
  const next = current.includes(period)
    ? current.filter((p) => p !== period)
    : [...current, period];
  const ordered = SMA_PERIODS.filter((p) => next.includes(p));
  return ordered.length ? ordered : [...current];
}

/**
 * Which average the trend-strength score is measured on. "auto" tracks the
 * slowest average currently on the chart.
 */
export type TrendBasis = SmaPeriod | "auto";

export const TREND_BASIS_KEY = "home-sma-trend-basis";

export function parseTrendBasis(raw: string | null | undefined): TrendBasis {
  const n = Number(raw);
  return Number.isFinite(n) && isSmaPeriod(n) ? (n as SmaPeriod) : "auto";
}

export function readStoredTrendBasis(): TrendBasis {
  try {
    return parseTrendBasis(window.localStorage.getItem(TREND_BASIS_KEY));
  } catch {
    return "auto";
  }
}

export function storeTrendBasis(basis: TrendBasis): void {
  try {
    window.localStorage.setItem(TREND_BASIS_KEY, String(basis));
  } catch {
    /* storage unavailable — in-memory choice still works */
  }
}

/** The period the score is actually measured on for a given selection. */
export function resolveTrendBasis(
  basis: TrendBasis,
  periods: readonly SmaPeriod[],
): SmaPeriod | null {
  if (basis !== "auto") return basis;
  const ordered = SMA_PERIODS.filter((p) => periods.includes(p));
  return ordered[ordered.length - 1] ?? null;
}

/** Sort / filter modes for the home card's trend-strength ranking. */
export type TrendSort = "selection" | "strongest" | "weakest";
export type TrendFilter = "all" | "up" | "down" | "significant";

export const TREND_SORT_KEY = "home-sma-trend-sort";
export const TREND_FILTER_KEY = "home-sma-trend-filter";

/** Scores at or beyond this magnitude count as a meaningful trend. */
export const TREND_SIGNIFICANT_SCORE = 20;

export function parseTrendSort(raw: string | null | undefined): TrendSort {
  return raw === "strongest" || raw === "weakest" ? raw : "selection";
}

export function parseTrendFilter(raw: string | null | undefined): TrendFilter {
  return raw === "up" || raw === "down" || raw === "significant" ? raw : "all";
}

/**
 * Order and filter symbols by trend-strength score. Entries with no score yet
 * (still loading, or too little history) keep their selection order and are
 * never filtered out, so the card never silently hides a chosen market.
 */
export function rankByTrendStrength<T extends { symbol: string; score: number | null }>(
  entries: readonly T[],
  sort: TrendSort,
  filter: TrendFilter,
): T[] {
  const kept = entries.filter((e) => {
    if (e.score == null) return true;
    if (filter === "up") return e.score > 0;
    if (filter === "down") return e.score < 0;
    if (filter === "significant") return Math.abs(e.score) >= TREND_SIGNIFICANT_SCORE;
    return true;
  });
  if (sort === "selection") return kept;
  const scored = kept.filter((e) => e.score != null);
  const unscored = kept.filter((e) => e.score == null);
  scored.sort((a, b) =>
    sort === "strongest" ? (b.score as number) - (a.score as number) : (a.score as number) - (b.score as number),
  );
  return [...scored, ...unscored];
}

/** Home card can chart up to this many markets side by side. */
export const MAX_SMA_SYMBOLS = 4;

/** Storage key for the home card's selected markets. */
export const SMA_SYMBOLS_KEY = "home-sma-symbols";

/** Parse a stored "SPY,QQQ" list, keeping only known symbols, max four. */
export function parseSmaSymbols(
  raw: string | null | undefined,
  isKnown: (s: string) => boolean,
): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of String(raw).split(",")) {
    const s = part.trim();
    if (s && isKnown(s) && !out.includes(s)) out.push(s);
    if (out.length >= MAX_SMA_SYMBOLS) break;
  }
  return out;
}

/** Add/remove a market; keeps at least one and never exceeds the cap. */
export function toggleSmaSymbol(current: readonly string[], symbol: string): string[] {
  if (current.includes(symbol)) {
    const next = current.filter((s) => s !== symbol);
    return next.length ? next : [...current];
  }
  if (current.length >= MAX_SMA_SYMBOLS) return [...current];
  return [...current, symbol];
}
