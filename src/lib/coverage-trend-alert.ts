export const COVERAGE_TREND_ALERT_CATEGORY = "broker_cost_coverage_trend";

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
/**
 * Points below the floor at which a shortfall stops being a nuisance and
 * becomes critical: at floor-25 (45% by default) most of the recent tape is
 * modelled rather than invoiced, so the friction KPI can no longer be read as
 * a measurement at all.
 */
export const COVERAGE_TREND_CRITICAL_GAP_PCT = 25;
/** Points of decline that count as a real deterioration rather than noise. */
export const COVERAGE_TREND_STEP_PCT = 5;
/** Days per comparison window. */
export const COVERAGE_TREND_WINDOW_DAYS = 7;
/** Minimum graded days in a window before it can be compared. */
const MIN_DAYS_PER_WINDOW = 3;
/**
 * Minimum gradeable fills behind the recent window before coverage is treated
 * as a measurement. A single un-invoiced trade prints "0% coverage" on every
 * day of the rolling window and reads as a catastrophic failure; it is really
 * one pending charge. Below this count we stay quiet rather than grading a
 * percentage whose denominator is one.
 */
export const COVERAGE_TREND_MIN_FILLS = 5;

export type CoverageTrendAlertReason = "below_floor" | "deteriorating" | "both";
export type CoverageTrendSeverity = "info" | "warning" | "critical";


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
  severity: CoverageTrendSeverity;
  /** Points below the floor (positive = shortfall), null when not below it. */
  gapPct: number | null;

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
  opts: {
    floorPct?: number;
    stepPct?: number;
    windowDays?: number;
    criticalGapPct?: number;
    minFills?: number;
  } = {},
): CoverageTrendAlert {
  const floor = opts.floorPct ?? COVERAGE_TREND_FLOOR_PCT;
  const step = opts.stepPct ?? COVERAGE_TREND_STEP_PCT;
  const criticalGap = opts.criticalGapPct ?? COVERAGE_TREND_CRITICAL_GAP_PCT;
  const minFills = Math.max(1, Math.trunc(opts.minFills ?? COVERAGE_TREND_MIN_FILLS));
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
    gapPct: null,
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

  // Too thin a tape to grade: one pending charge on a quiet week is not a
  // broken cost feed, and shouting "critically low" about it trains the owner
  // to ignore the alert that matters.
  if (recent.total < minFills) {
    return {
      ...quiet,
      title: "Broker charge coverage not gradeable",
      body:
        `Only ${recent.total} gradeable fill${recent.total === 1 ? "" : "s"} in the last ` +
        `${windowDays} days (coverage ${recentPct}%), below the ${minFills}-fill minimum, ` +
        "so the coverage percentage is not yet meaningful.",
    };
  }

  const belowFloor = recentPct < floor;
  const deteriorating =
    priorPct != null &&
    earlierPct != null &&
    recentPct <= priorPct - step &&
    priorPct <= earlierPct - step;

  if (!belowFloor && !deteriorating) return quiet;

  const reason: CoverageTrendAlertReason =
    belowFloor && deteriorating ? "both" : belowFloor ? "below_floor" : "deteriorating";

  const gapPct = belowFloor ? Math.round((floor - recentPct) * 10) / 10 : null;

  // Severity ladder:
  //   info     — still above the floor, but sliding two windows running.
  //   warning  — under the floor, or the slide has become steep (>= 2 steps
  //              per window) even while above it.
  //   critical — a deep shortfall (>= criticalGap below the floor), or under
  //              the floor *and* still falling, which means it will get worse.
  const steepSlide =
    priorPct != null && earlierPct != null && recentPct <= priorPct - 2 * step && priorPct <= earlierPct - 2 * step;
  let severity: CoverageTrendSeverity;
  if (gapPct != null && (gapPct >= criticalGap || deteriorating)) severity = "critical";
  else if (belowFloor || steepSlide) severity = "warning";
  else severity = "info";

  const slide =
    priorPct != null && earlierPct != null
      ? ` It has fallen across two consecutive windows: ${earlierPct}% → ${priorPct}% → ${recentPct}%.`
      : "";

  const severityNote =
    severity === "critical"
      ? gapPct != null && gapPct >= criticalGap
        ? ` That is ${gapPct} points below the floor — treat the friction KPI as an estimate, not a measurement.`
        : " It is below the floor and still falling, so expect it to worsen without a fix."
      : "";

  const body = belowFloor
    ? `Only ${recentPct}% of the last ${windowDays} days of fills carry a booked Saxo charge, below the ${floor}% floor. Trading costs for the rest are modelled, so the friction figure is a projection.${deteriorating ? slide : ""}${severityNote}`
    : `Broker charge coverage is sliding.${slide} It is still above the ${floor}% floor, but the trend points at charges that are no longer matching.`;

  const title = belowFloor
    ? severity === "critical"
      ? "Broker charge coverage critically low"
      : "Broker charge coverage below floor"
    : "Broker charge coverage degrading";

  return {
    shouldAlert: true,
    reason,
    severity,
    gapPct,
    recentPct,
    priorPct,
    earlierPct,
    windows,
    title,
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

