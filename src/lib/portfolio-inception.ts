// Portfolio inception: the first date a portfolio genuinely existed.
//
// Equity snapshots can predate a portfolio for two reasons: seeded/backtest
// rows written against an earlier experiment, and broker syncs that pull a
// Saxo account's older history into a freshly created live portfolio. Both
// render as "performance" on charts for a period when the portfolio — and in
// the live case, the funded account — did not exist yet.
//
// Inception is the later of the row's creation and its live activation, so a
// live portfolio's charts start the day it actually went live.

export type InceptionSource = {
  created_at?: string | null;
  live_activated_at?: string | null;
};

function toDay(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** ISO `YYYY-MM-DD` inception day, or null when unknown (never clip then). */
export function portfolioInceptionDate(p: InceptionSource | null | undefined): string | null {
  if (!p) return null;
  const created = toDay(p.created_at);
  const live = toDay(p.live_activated_at);
  if (created && live) return created > live ? created : live;
  return created ?? live ?? null;
}

/**
 * Drop rows dated before inception. A null inception keeps everything.
 *
 * Safety valve: when EVERY row predates inception the clip is not a phantom
 * pre-history — it is a portfolio whose entire recorded history is dated
 * earlier than its row (backtest replays over historical dates, imported
 * ledgers). Wiping the series there leaves the card with "no equity snapshots
 * yet" despite real data, so we keep the rows untouched in that case.
 */
export function clipToInception<T>(
  rows: readonly T[],
  inception: string | null,
  getDate: (row: T) => string | null | undefined,
): T[] {
  if (!inception) return [...rows];
  const kept = rows.filter((row) => {
    const d = toDay(getDate(row));
    return d === null ? true : d >= inception;
  });
  if (kept.length === 0 && rows.length > 0) return [...rows];
  return kept;
}

/**
 * First day the portfolio actually held something: the earliest holding open
 * date or executed trade, whichever is earlier. Backtest and broker-imported
 * accounts (e.g. "High risk sim") can carry rows created before any position
 * existed, so this is the honest start of the performance series.
 */
export function firstHoldingsDate(
  holdings: ReadonlyArray<{ opened_at?: unknown; created_at?: unknown }> | null | undefined,
  trades?: ReadonlyArray<{ executed_at?: unknown }> | null,
): string | null {
  let earliest: string | null = null;
  const take = (v: unknown) => {
    const d = toDay(v);
    if (d && (earliest === null || d < earliest)) earliest = d;
  };
  for (const h of holdings ?? []) take(h.opened_at ?? h.created_at);
  for (const t of trades ?? []) take(t.executed_at);
  return earliest;
}

/**
 * The date the chart/series should say it starts: the first real holdings day
 * when it is known and not earlier than inception, else inception.
 */
export function seriesStartDate(
  inception: string | null,
  firstHoldings: string | null,
): string | null {
  if (!firstHoldings) return inception;
  if (!inception) return firstHoldings;
  return firstHoldings > inception ? firstHoldings : inception;
}
