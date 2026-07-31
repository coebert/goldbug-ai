// Server driver for historical equity-snapshot revaluation.
//
// Loads the ledger inputs, runs the pure planner, and upserts the corrected
// rows on (portfolio_id, snapshot_date). Idempotent.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  planHistoricalRevaluation,
  symbolKeys,
  type RevalueFill,
  type RevalueHolding,
  type RevalueReport,
  type RevalueSnapshot,
} from "./equity-snapshot-revalue";
import { portfolioInceptionDate } from "./portfolio-inception";

export type RevalueRunResult = RevalueReport & {
  written: number;
  dryRun: boolean;
  error?: string;
};

/** Full daily close history for every spelling of the given symbols. */
async function loadPriceHistory(
  supabase: SupabaseClient,
  symbols: string[],
  since: string,
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  const keys = [...new Set(symbols.flatMap((s) => symbolKeys(s)))];
  if (keys.length === 0) return out;

  const { data } = await supabase
    .from("price_cache")
    .select("symbol, price_date, close")
    .gte("price_date", since)
    .order("price_date", { ascending: true });

  const wanted = new Set(keys);
  for (const row of data ?? []) {
    const symbol = String((row as { symbol: unknown }).symbol ?? "").toUpperCase();
    if (!wanted.has(symbol)) continue;
    const close = Number((row as { close: unknown }).close);
    if (!Number.isFinite(close) || close <= 0) continue;
    const date = String((row as { price_date: unknown }).price_date).slice(0, 10);
    const series = out.get(symbol) ?? new Map<string, number>();
    series.set(date, close);
    out.set(symbol, series);
  }
  return out;
}

export async function revalueHistoricalSnapshots(
  supabase: SupabaseClient,
  portfolioId: string,
  options: { dryRun?: boolean; today?: string } = {},
): Promise<RevalueRunResult> {
  const dryRun = options.dryRun === true;
  const empty: RevalueRunResult = {
    portfolio_id: portfolioId,
    daysScanned: 0,
    rows: [],
    skipped: [],
    written: 0,
    dryRun,
  };

  const [{ data: portfolio }, { data: snapshotRows }, { data: holdingRows }, { data: fillRows }] =
    await Promise.all([
      supabase
        .from("portfolios")
        .select("id, created_at, live_activated_at")
        .eq("id", portfolioId)
        .maybeSingle(),
      supabase
        .from("equity_snapshots")
        .select("snapshot_date, cash, holdings_value, total_value")
        .eq("portfolio_id", portfolioId)
        .order("snapshot_date", { ascending: true }),
      supabase
        .from("holdings")
        .select("symbol, quantity, avg_cost, asset_class, opened_at")
        .eq("portfolio_id", portfolioId)
        .gt("quantity", 0),
      supabase
        .from("live_fills")
        .select("symbol, side, quantity, filled_at")
        .eq("portfolio_id", portfolioId)
        .order("filled_at", { ascending: true }),
    ]);

  if (!portfolio) return { ...empty, error: "portfolio not found" };

  const snapshots = (snapshotRows ?? []) as RevalueSnapshot[];
  if (snapshots.length === 0) return empty;
  const holdings = (holdingRows ?? []) as RevalueHolding[];
  const fills = (fillRows ?? []) as RevalueFill[];

  const inception = portfolioInceptionDate({
    created_at: (portfolio as { created_at?: string | null }).created_at ?? null,
    live_activated_at: (portfolio as { live_activated_at?: string | null }).live_activated_at ?? null,
  });
  const since = String(snapshots[0]!.snapshot_date).slice(0, 10);
  const prices = await loadPriceHistory(
    supabase,
    holdings.map((h) => String(h.symbol)).concat(fills.map((f) => String(f.symbol))),
    since,
  );

  const report = planHistoricalRevaluation({
    portfolioId,
    snapshots,
    holdings,
    fills,
    prices,
    inception,
    today: options.today ?? new Date().toISOString().slice(0, 10),
  });

  if (dryRun || report.rows.length === 0) {
    return { ...report, written: 0, dryRun };
  }

  const { error } = await supabase.from("equity_snapshots").upsert(
    report.rows.map((r) => ({
      portfolio_id: portfolioId,
      snapshot_date: r.snapshot_date,
      cash: r.cash,
      holdings_value: r.holdings_value,
      total_value: r.total_value,
    })),
    { onConflict: "portfolio_id,snapshot_date" },
  );

  return {
    ...report,
    written: error ? 0 : report.rows.length,
    dryRun,
    ...(error ? { error: error.message } : {}),
  };
}
