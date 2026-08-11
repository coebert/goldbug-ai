// Grading of the broker-charge coverage *trend*, as opposed to the current
// coverage snapshot the status strip already shows.
//
// Two failure shapes matter and neither is visible in a single percentage:
//
//  1. Coverage over the last 7 days has fallen below a floor — most of the
//     recent tape is being priced by our own model, so the friction KPI is a
//     projection for the trades we care about most.
//  2. Coverage has deteriorated across two consecutive 7-day windows — even
//     if the level is still respectable, something is steadily rotting
//     (a venue we stopped matching, a report that keeps timing out).
//
// This module is pure so the hourly notifier, the dashboard banner and the
// tests all grade identically.

import type { CoverageSeries } from "./fee-coverage-trend";

/** Coverage floor, in percentage points, for the trailing 7-day window. */
export const COVERAGE_TREND_FLOOR_PCT = 70;
/** Points of decline that count as a real deterioration rather than noise. */
export const COVERAGE_TREND_STEP_PCT = 5;
/** Days per comparison window. */
export const COVERAGE_TREND_WINDOW_DAYS = 7;
/** Minimum graded days in a window before it can be compared. */
const MIN_DAYS_PER_WINDOW = 3;

export type CoverageTrendAlertReason = "below_floor" | "deteriorating" | "both";

/** One comparison window, carrying the dates and counts behind its number. */
export type CoverageWindowSummary = {
  /** 0 = most recent window, 1 = the one before it. */
  index: number;
  /** First day included, YYYY-MM-DD. */
  startDate: string | null;
  /** Last day included, YYYY-MM-DD. */
  endDate: string | null;
  /** Mean daily coverage across the graded days, 0..100, or null. */
  coveragePct: number | null;
  /** Days in the window that had gradeable fills. */
  gradedDays: number;
  /** Fills invoiced / gradeable on the final day of the window. */
  invoiced: number;
  total: number;
};

export type CoverageTrendAlert = {
  shouldAlert: boolean;
  reason: CoverageTrendAlertReason | null;
  severity: "info" | "warning" | "critical";
  /** Mean coverage over the most recent window, 0..100, or null. */
  recentPct: number | null;
  /** Mean coverage over the preceding window. */
  priorPct: number | null;
  /** Mean coverage over the window before that. */
  earlierPct: number | null;
  /** The last two windows used in the comparison, newest first. */
  windows: [CoverageWindowSummary, CoverageWindowSummary];
  title: string;
  body: string;
};

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.round((sum / values.length) * 10) / 10;
}

/** Summarise the nth-most-recent window (0 = latest). */
function windowSummary(
  series: CoverageSeries,
  index: number,
  windowDays: number,
): CoverageWindowSummary {
  const pts = series.points;
  const end = pts.length - index * windowDays;
  const start = end - windowDays;
  const slice = end <= 0 ? [] : pts.slice(Math.max(0, start), end);
  const graded = slice.filter((p) => p.coveragePct != null && p.total > 0);
  const last = graded[graded.length - 1];
  return {
    index,
    startDate: slice[0]?.date ?? null,
    endDate: slice[slice.length - 1]?.date ?? null,
    coveragePct:
      graded.length < MIN_DAYS_PER_WINDOW ? null : mean(graded.map((p) => p.coveragePct as number)),
    gradedDays: graded.length,
    invoiced: last?.invoiced ?? 0,
    total: last?.total ?? 0,
  };
}

export function evaluateCoverageTrendAlert(
  series: CoverageSeries,
  opts: { floorPct?: number; stepPct?: number; windowDays?: number } = {},
): CoverageTrendAlert {
  const floor = opts.floorPct ?? COVERAGE_TREND_FLOOR_PCT;
  const step = opts.stepPct ?? COVERAGE_TREND_STEP_PCT;
  const windowDays = Math.max(1, Math.trunc(opts.windowDays ?? COVERAGE_TREND_WINDOW_DAYS));

  const recent = windowSummary(series, 0, windowDays);
  const prior = windowSummary(series, 1, windowDays);
  const earlier = windowSummary(series, 2, windowDays);
  const recentPct = recent.coveragePct;
  const priorPct = prior.coveragePct;
  const earlierPct = earlier.coveragePct;
  const windows: [CoverageWindowSummary, CoverageWindowSummary] = [recent, prior];

  const quiet: CoverageTrendAlert = {
    shouldAlert: false,
    reason: null,
    severity: "info",
    recentPct,
    priorPct,
    earlierPct,
    windows,
    title: "Broker charge coverage steady",
    body:
      recentPct == null
        ? `No gradeable fills in the last ${windowDays} days.`
        : `Coverage over the last ${windowDays} days is ${recentPct}%.`,
  };

  if (recentPct == null) return quiet;

  const belowFloor = recentPct < floor;
  const deteriorating =
    priorPct != null &&
    earlierPct != null &&
    recentPct <= priorPct - step &&
    priorPct <= earlierPct - step;

  if (!belowFloor && !deteriorating) return quiet;

  const reason: CoverageTrendAlertReason =
    belowFloor && deteriorating ? "both" : belowFloor ? "below_floor" : "deteriorating";

  const slide =
    priorPct != null && earlierPct != null
      ? ` It has fallen across two consecutive windows: ${earlierPct}% → ${priorPct}% → ${recentPct}%.`
      : "";

  const body = belowFloor
    ? `Only ${recentPct}% of the last ${windowDays} days of fills carry a booked Saxo charge, below the ${floor}% floor. Trading costs for the rest are modelled, so the friction figure is a projection.${deteriorating ? slide : ""}`
    : `Broker charge coverage is sliding.${slide} It is still above the ${floor}% floor, but the trend points at charges that are no longer matching.`;

  return {
    shouldAlert: true,
    reason,
    severity: belowFloor ? "warning" : "info",
    recentPct,
    priorPct,
    earlierPct,
    windows,
    title: belowFloor ? "Broker charge coverage below floor" : "Broker charge coverage degrading",
    body,
  };
}

/** "01 Jul – 07 Jul" for a window, for banners and notification bodies. */
export function formatCoverageWindow(w: CoverageWindowSummary): string {
  const fmt = (d: string | null) => {
    const t = d ? Date.parse(d) : Number.NaN;
    return Number.isFinite(t)
      ? new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
      : "—";
  };
  return `${fmt(w.startDate)} – ${fmt(w.endDate)}`;
}

