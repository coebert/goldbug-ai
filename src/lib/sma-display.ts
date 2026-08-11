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
