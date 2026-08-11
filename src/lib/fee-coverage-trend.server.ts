import {
  buildCoverageTrend,
  COVERAGE_TREND_DAYS,
  COVERAGE_WINDOW_DAYS,
  type CoverageFill,
  type CoverageTrend,
} from "./fee-coverage-trend";

type DbClient = { from: (t: string) => any };

export async function loadCoverageTrend(args: {
  db: DbClient;
  days?: number;
  windowDays?: number;
  now?: Date;
}): Promise<CoverageTrend> {
  const days = args.days ?? COVERAGE_TREND_DAYS;
  const windowDays = args.windowDays ?? COVERAGE_WINDOW_DAYS;
  const now = args.now ?? new Date();
  // One extra window of tape so the left-hand points are full reads rather
  // than an artefact of where the query was truncated.
  const since = new Date(now.getTime() - (days + windowDays) * 86_400_000).toISOString();

  let portfolios: Array<{ id: string; name: string }> = [];
  try {
    const res = await args.db.from("portfolios").select("id, name").limit(200);
    portfolios = ((res?.data ?? []) as Array<Record<string, unknown>>).map((p) => ({
      id: String(p["id"] ?? ""),
      name: String(p["name"] ?? "Portfolio"),
    }));
  } catch {
    portfolios = [];
  }

  let fills: CoverageFill[] = [];
  try {
    const res = await args.db
      .from("live_fills")
      .select(
        "portfolio_id, filled_at, fee, fee_source, fee_sync_status, fee_sync_reason, fee_synced_at, fee_sync_attempted_at",
      )
      .gte("filled_at", since)
      .order("filled_at", { ascending: true })
      .limit(5000);
    fills = ((res?.data ?? []) as Array<Record<string, unknown>>)
      .map((r) => ({
        portfolioId: String(r["portfolio_id"] ?? ""),
        filledAt: String(r["filled_at"] ?? ""),
        fee: Number(r["fee"] ?? 0),
        feeSource: r["fee_source"],
        feeSyncStatus: r["fee_sync_status"],
        feeSyncReason: (r["fee_sync_reason"] as string | null) ?? null,
        feeSyncedAt: (r["fee_synced_at"] as string | null) ?? null,
        feeSyncAttemptedAt: (r["fee_sync_attempted_at"] as string | null) ?? null,
      }))
      .filter((f) => f.portfolioId && f.filledAt);
  } catch {
    fills = [];
  }

  return buildCoverageTrend({ fills, portfolios, days, windowDays, now });
}
