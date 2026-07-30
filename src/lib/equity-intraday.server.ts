// Hourly equity history.
//
// `equity_snapshots` is keyed by DATE, so a portfolio that runs every hour
// collapses to one point per day and any intraday movement is invisible.
// Every place that writes a daily snapshot also drops an hour-bucketed row
// here so the equity chart can zoom into hourly detail.
//
// Rows are bucketed with date_trunc('hour') semantics computed client-side and
// upserted, so repeated runs inside the same hour overwrite rather than
// accumulate.

type MinimalDb = {
  from: (table: string) => {
    upsert: (values: unknown, options?: { onConflict?: string }) => Promise<{ error?: unknown }>;
  };
};

/** Start of the UTC hour containing `d`, as an ISO timestamp. */
export function hourBucket(d: Date = new Date()): string {
  const b = new Date(d);
  b.setUTCMinutes(0, 0, 0);
  return b.toISOString();
}

/**
 * Record (or overwrite) the hourly equity point for a portfolio.
 * Never throws: intraday history is telemetry, not a transactional write, so a
 * failure here must not roll back the run that produced the numbers.
 */
export async function recordIntradayEquity(
  db: MinimalDb,
  portfolioId: string,
  point: { cash: number; holdingsValue: number; totalValue: number },
  at: Date = new Date(),
): Promise<void> {
  const { cash, holdingsValue, totalValue } = point;
  if (![cash, holdingsValue, totalValue].every((n) => Number.isFinite(n))) return;
  try {
    await db.from("equity_intraday").upsert(
      {
        portfolio_id: portfolioId,
        bucket_hour: hourBucket(at),
        cash,
        holdings_value: holdingsValue,
        total_value: totalValue,
      },
      { onConflict: "portfolio_id,bucket_hour" },
    );
  } catch (e) {
    console.warn("intraday equity point skipped", e);
  }
}
