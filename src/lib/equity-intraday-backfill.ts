// Deriving hourly equity anchors from daily history.
//
// `equity_intraday` only started being written when hourly recording shipped,
// so every portfolio that existed before then shows an almost-empty Hourly
// view even though months of daily history exist. This module converts the
// daily `equity_snapshots` series into hour-bucketed rows so the Hourly view
// opens with the full shape of the portfolio's life.
//
// What this deliberately does NOT do: invent intra-day movement. We only know
// one equity value per historical day, so each backfilled day contributes
// exactly one point, placed at the hour the daily snapshot represents. The
// hourly line therefore matches the daily line over backfilled history and
// only gains genuine intra-hour detail from the moment live recording began.
// Interpolating between daily closes would look smoother and be fiction.

/** A daily equity snapshot row (only the fields we need). */
export type SnapshotLite = {
  snapshot_date: string;
  cash?: number | string | null;
  holdings_value?: number | string | null;
  total_value: number | string;
};

export type IntradayRow = {
  portfolio_id: string;
  bucket_hour: string;
  cash: number;
  holdings_value: number;
  total_value: number;
};

/**
 * UTC hour a daily snapshot is attributed to. 21:00 UTC sits after the US
 * close and after every venue we trade, so the anchor never lands "before"
 * intra-day activity it is meant to summarise.
 */
export const SNAPSHOT_ANCHOR_HOUR_UTC = 21;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** ISO timestamp for `date` at the anchor hour, clamped to `now`. */
export function anchorBucketFor(date: string, now: Date = new Date()): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return null;
  const at = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), SNAPSHOT_ANCHOR_HOUR_UTC, 0, 0, 0),
  );
  // Today's snapshot must not be stamped in the future, or the chart shows a
  // point ahead of "now" and the x-axis stretches into empty space.
  if (at.getTime() > now.getTime()) {
    const clamped = new Date(now);
    clamped.setUTCMinutes(0, 0, 0);
    // Never move the anchor onto a different calendar day than the snapshot.
    if (clamped.toISOString().slice(0, 10) !== date.slice(0, 10)) return null;
    return clamped.toISOString();
  }
  return at.toISOString();
}

/**
 * Build the hourly rows to insert for one portfolio.
 *
 * `existingBuckets` are hours already present in `equity_intraday`; those are
 * real recorded points and are never replaced by a derived anchor.
 */
export function deriveIntradayAnchors(
  portfolioId: string,
  snapshots: SnapshotLite[],
  existingBuckets: Iterable<string> = [],
  now: Date = new Date(),
): IntradayRow[] {
  const taken = new Set<string>();
  for (const b of existingBuckets) {
    const t = Date.parse(b);
    if (Number.isFinite(t)) {
      const d = new Date(t);
      d.setUTCMinutes(0, 0, 0);
      taken.add(d.toISOString());
    }
  }

  const rows: IntradayRow[] = [];
  const seen = new Set<string>();
  for (const s of snapshots) {
    const total = Number(s.total_value);
    if (!Number.isFinite(total)) continue;
    const bucket = anchorBucketFor(String(s.snapshot_date ?? ""), now);
    if (!bucket || taken.has(bucket) || seen.has(bucket)) continue;
    seen.add(bucket);

    // Older snapshots may predate the cash/holdings split; fall back to
    // attributing everything to holdings-free cash rather than writing NaN.
    const hasSplit = s.cash != null && s.holdings_value != null;
    const cash = hasSplit ? num(s.cash) : total;
    const holdings = hasSplit ? num(s.holdings_value) : 0;

    rows.push({
      portfolio_id: portfolioId,
      bucket_hour: bucket,
      cash,
      holdings_value: holdings,
      total_value: total,
    });
  }
  return rows.sort((a, b) => a.bucket_hour.localeCompare(b.bucket_hour));
}
