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

/** Sort / filter modes for the home card's trend ranking. */
export type TrendSort =
  | "selection"
  | "strongest"
  | "weakest"
  | "slope-desc"
  | "slope-asc"
  | "vol-desc"
  | "vol-asc";
export type TrendFilter = "all" | "up" | "down" | "significant";

const TREND_SORTS: readonly TrendSort[] = [
  "selection",
  "strongest",
  "weakest",
  "slope-desc",
  "slope-asc",
  "vol-desc",
  "vol-asc",
];

export const TREND_SORT_KEY = "home-sma-trend-sort";
export const TREND_FILTER_KEY = "home-sma-trend-filter";
/** Optional tie-breaker sort applied after the primary sort. */
export const TREND_SORT2_KEY = "home-sma-trend-sort2";


/** Scores at or beyond this magnitude count as a meaningful trend. */
export const TREND_SIGNIFICANT_SCORE = 20;

export function parseTrendSort(raw: string | null | undefined): TrendSort {
  return TREND_SORTS.includes(raw as TrendSort) ? (raw as TrendSort) : "selection";
}

export function parseTrendFilter(raw: string | null | undefined): TrendFilter {
  return raw === "up" || raw === "down" || raw === "significant" ? raw : "all";
}

/** Metric a sort mode reads, and whether it runs high→low. */
export function trendSortSpec(
  sort: TrendSort,
): { field: "score" | "slope" | "volatility"; desc: boolean } | null {
  switch (sort) {
    case "strongest":
      return { field: "score", desc: true };
    case "weakest":
      return { field: "score", desc: false };
    case "slope-desc":
      return { field: "slope", desc: true };
    case "slope-asc":
      return { field: "slope", desc: false };
    case "vol-desc":
      return { field: "volatility", desc: true };
    case "vol-asc":
      return { field: "volatility", desc: false };
    default:
      return null;
  }
}

export type TrendRankEntry = {
  symbol: string;
  score: number | null;
  /** Pinned markets stay visible and sort ahead of everything else. */
  favorite?: boolean;
  /** Annualised slope of the basis average, in % per year. */
  slope?: number | null;
  /** Annualised volatility, in % per year. */
  volatility?: number | null;
};

/** Percentile ranks of one market's metrics within the compared set. */
export type TrendPercentiles = { slope: number | null; volatility: number | null; count: number };

/**
 * Percentile rank (0-100) of `value` within `values`, counting ties as half.
 * Needs at least two comparable markets to mean anything.
 */
export function percentileRank(value: number, values: readonly number[]): number | null {
  const pool = values.filter((v) => Number.isFinite(v));
  if (pool.length < 2) return null;
  let below = 0;
  let equal = 0;
  for (const v of pool) {
    if (v < value) below += 1;
    else if (v === value) equal += 1;
  }
  return Math.round(((below + equal / 2) / pool.length) * 100);
}

/** Percentile ranks for each symbol's slope and volatility across the set. */
export function trendPercentiles(
  entries: readonly TrendRankEntry[],
): Record<string, TrendPercentiles> {
  const slopes = entries.map((e) => e.slope).filter((v): v is number => v != null);
  const vols = entries.map((e) => e.volatility).filter((v): v is number => v != null);
  const out: Record<string, TrendPercentiles> = {};
  for (const e of entries) {
    out[e.symbol] = {
      slope: e.slope != null ? percentileRank(e.slope, slopes) : null,
      volatility: e.volatility != null ? percentileRank(e.volatility, vols) : null,
      count: entries.length,
    };
  }
  return out;
}


/**
 * Order and filter symbols by trend metrics. Entries with no value yet (still
 * loading, or too little history) keep their selection order at the end and
 * are never filtered out, so the card never silently hides a chosen market.
 */
export function rankByTrendStrength<T extends TrendRankEntry>(
  entries: readonly T[],
  sort: TrendSort,
  filter: TrendFilter,
  /** Optional tie-breaker applied when the primary values are equal. */
  secondary: TrendSort = "selection",
  /** Explicit sequence for pinned markets; unlisted pins keep their order after. */
  pinnedOrder: readonly string[] = [],
): T[] {
  const kept = entries.filter((e) => {
    if (e.favorite) return true;
    if (e.score == null) return true;
    if (filter === "up") return e.score > 0;
    if (filter === "down") return e.score < 0;
    if (filter === "significant") return Math.abs(e.score) >= TREND_SIGNIFICANT_SCORE;
    return true;
  });
  const spec = trendSortSpec(sort);
  const pinRank = (e: T) => {
    const i = pinnedOrder.indexOf(e.symbol);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const pin = (list: T[]) => {
    const pinned = list.filter((e) => e.favorite);
    const stable = new Map(pinned.map((e, i) => [e, i] as const));
    pinned.sort((a, b) => pinRank(a) - pinRank(b) || (stable.get(a) ?? 0) - (stable.get(b) ?? 0));
    return [...pinned, ...list.filter((e) => !e.favorite)];
  };
  if (!spec) return pin(kept);


  const read = (e: T, field: "score" | "slope" | "volatility") =>
    field === "score" ? e.score : field === "slope" ? (e.slope ?? null) : (e.volatility ?? null);
  const primary = (e: T) => read(e, spec.field);
  const tie = trendSortSpec(secondary);

  const ranked = kept.filter((e) => primary(e) != null);
  const unranked = kept.filter((e) => primary(e) == null);
  // Index map keeps the sort stable on a full tie (selection order wins).
  const order = new Map(kept.map((e, i) => [e, i] as const));
  ranked.sort((a, b) => {
    const d = spec.desc
      ? (primary(b) as number) - (primary(a) as number)
      : (primary(a) as number) - (primary(b) as number);
    if (d !== 0) return d;
    if (tie && tie.field !== spec.field) {
      const av = read(a, tie.field);
      const bv = read(b, tie.field);
      if (av != null && bv != null) {
        const t = tie.desc ? bv - av : av - bv;
        if (t !== 0) return t;
      } else if (av != null) return -1;
      else if (bv != null) return 1;
    }
    return (order.get(a) ?? 0) - (order.get(b) ?? 0);
  });
  return pin([...ranked, ...unranked]);
}


/** Storage key for pinned markets on the home card. */
export const SMA_FAVORITES_KEY = "home-sma-favorites";

export function parseSmaFavorites(
  raw: string | null | undefined,
  isKnown: (s: string) => boolean,
): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of String(raw).split(",")) {
    const s = part.trim();
    if (s && isKnown(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

export function toggleSmaFavorite(current: readonly string[], symbol: string): string[] {
  return current.includes(symbol)
    ? current.filter((s) => s !== symbol)
    : [...current, symbol];
}

/** Move a pinned market one slot up or down in the pinned sequence. */
export function moveSmaFavorite(
  current: readonly string[],
  symbol: string,
  direction: "up" | "down",
): string[] {
  const i = current.indexOf(symbol);
  if (i === -1) return [...current];
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= current.length) return [...current];
  const next = [...current];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}


export function storeSmaFavorites(favorites: readonly string[]): void {
  try {
    window.localStorage.setItem(SMA_FAVORITES_KEY, favorites.join(","));
  } catch {
    /* storage unavailable — in-memory pins still work */
  }
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
