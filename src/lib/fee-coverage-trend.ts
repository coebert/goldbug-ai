// Is Saxo charge coverage getting better or worse?
//
// The status strip answers "how much of the tape is broker-priced right now".
// It cannot say whether that number is recovering after a bad sync or quietly
// rotting. This module turns the per-fill sync statuses into a trailing-window
// coverage curve per portfolio plus an all-portfolios line, so a degrading
// venue shows up as a slope rather than as a single disappointing percentage.
//
// Coverage at day D = share of fills filled in (D - windowDays, D] that carry
// a broker-booked charge. Fills that will never be priced (`unsupported`) are
// excluded from the denominator: counting them would peg an account with no
// cost report at 0% forever and drown the signal from accounts that do.

import { coerceFeeSyncStatus, type FeeSyncRow } from "./fee-sync-status";

/** Days of tape each point looks back over. */
export const COVERAGE_WINDOW_DAYS = 14;
/** Length of the trend chart. */
export const COVERAGE_TREND_DAYS = 60;

export type CoverageFill = FeeSyncRow & {
  portfolioId: string;
  /** ISO timestamp of the fill. */
  filledAt: string;
};

export type CoveragePoint = {
  /** YYYY-MM-DD */
  date: string;
  /** 0..100, or null when no gradeable fills sit in the window. */
  coveragePct: number | null;
  invoiced: number;
  total: number;
};

export type CoverageDirection = "improving" | "degrading" | "flat" | "unknown";

export type CoverageSeries = {
  portfolioId: string | null;
  label: string;
  points: CoveragePoint[];
  /** Latest non-null coverage, 0..100, or null. */
  latestPct: number | null;
  /** Change in coverage points between the first and last graded day. */
  changePct: number | null;
  direction: CoverageDirection;
};

export type CoverageTrend = {
  dates: string[];
  overall: CoverageSeries;
  portfolios: CoverageSeries[];
  windowDays: number;
};

/** Anything below this move counts as flat rather than a real trend. */
const FLAT_BAND_PCT = 2;

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function seriesFrom(
  portfolioId: string | null,
  label: string,
  fills: CoverageFill[],
  dates: string[],
  windowDays: number,
): CoverageSeries {
  const graded = fills
    .map((f) => ({ t: Date.parse(f.filledAt), status: coerceFeeSyncStatus(f) }))
    .filter((f) => Number.isFinite(f.t) && f.status !== "unsupported")
    .sort((a, b) => a.t - b.t);

  const points: CoveragePoint[] = dates.map((date) => {
    // Inclusive of the whole day so a fill booked at 16:30 counts on its day.
    const end = Date.parse(`${date}T23:59:59.999Z`);
    const start = end - windowDays * 86_400_000;
    let total = 0;
    let invoiced = 0;
    for (const f of graded) {
      if (f.t <= start || f.t > end) continue;
      total += 1;
      if (f.status === "invoiced") invoiced += 1;
    }
    return {
      date,
      total,
      invoiced,
      coveragePct: total > 0 ? Math.round((invoiced / total) * 1000) / 10 : null,
    };
  });

  const graded_pts = points.filter((p) => p.coveragePct != null);
  const first = graded_pts[0]?.coveragePct ?? null;
  const latestPct = graded_pts.length ? graded_pts[graded_pts.length - 1]!.coveragePct : null;
  const changePct =
    first != null && latestPct != null ? Math.round((latestPct - first) * 10) / 10 : null;
  const direction: CoverageDirection =
    changePct == null || graded_pts.length < 2
      ? "unknown"
      : changePct > FLAT_BAND_PCT
        ? "improving"
        : changePct < -FLAT_BAND_PCT
          ? "degrading"
          : "flat";

  return { portfolioId, label, points, latestPct, changePct, direction };
}

export function buildCoverageTrend(args: {
  fills: readonly CoverageFill[];
  portfolios: readonly { id: string; name: string }[];
  days?: number;
  windowDays?: number;
  now?: Date;
}): CoverageTrend {
  const days = Math.max(2, Math.trunc(args.days ?? COVERAGE_TREND_DAYS));
  const windowDays = Math.max(1, Math.trunc(args.windowDays ?? COVERAGE_WINDOW_DAYS));
  const nowMs = (args.now ?? new Date()).getTime();

  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) dates.push(dayKey(nowMs - i * 86_400_000));

  const all = [...args.fills];
  const byPortfolio = new Map<string, CoverageFill[]>();
  for (const f of all) {
    const bag = byPortfolio.get(f.portfolioId) ?? [];
    bag.push(f);
    byPortfolio.set(f.portfolioId, bag);
  }

  const portfolios = args.portfolios
    .filter((p) => (byPortfolio.get(p.id) ?? []).length > 0)
    .map((p) => seriesFrom(p.id, p.name, byPortfolio.get(p.id) ?? [], dates, windowDays));

  return {
    dates,
    windowDays,
    overall: seriesFrom(null, "All portfolios", all, dates, windowDays),
    portfolios,
  };
}
