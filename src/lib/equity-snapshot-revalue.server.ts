// Server driver for historical equity-snapshot revaluation.
//
// Loads the ledger inputs, runs the pure planner, and upserts the corrected
// rows on (portfolio_id, snapshot_date). Idempotent.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  instrumentCurrency,
  planHistoricalRevaluation,
  symbolKeys,
  type RevalueFill,
  type RevalueHolding,
  type RevalueReport,
  type RevalueSnapshot,
} from "./equity-snapshot-revalue";
import { portfolioInceptionDate } from "./portfolio-inception";
import { writeEquitySnapshots } from "./valuation/write-snapshot.server";

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

  const [
    { data: portfolio },
    { data: snapshotRows },
    { data: holdingRows },
    { data: fillRows },
    { data: fundRows },
  ] = await Promise.all([
      supabase
        .from("portfolios")
        .select("id, created_at, live_activated_at, currency")
        .eq("id", portfolioId)
        .maybeSingle(),
      supabase
        .from("equity_snapshots")
        .select("snapshot_date, cash, holdings_value, total_value")
        .eq("portfolio_id", portfolioId)
        .order("snapshot_date", { ascending: true }),
      supabase
        .from("holdings")
        .select("symbol, quantity, avg_cost, asset_class, opened_at, instrument_ccy")
        .eq("portfolio_id", portfolioId)
        .gt("quantity", 0),
      supabase
        .from("live_fills")
        .select("symbol, side, quantity, fill_price, filled_at")
        .eq("portfolio_id", portfolioId)
        .order("filled_at", { ascending: true }),
      supabase
        .from("sim_fund_events")
        .select("amount, created_at")
        .eq("portfolio_id", portfolioId)
        .order("created_at", { ascending: true }),
    ]);

  if (!portfolio) return { ...empty, error: "portfolio not found" };

  const snapshots = (snapshotRows ?? []) as RevalueSnapshot[];
  if (snapshots.length === 0) return empty;
  const holdings = (holdingRows ?? []) as RevalueHolding[];
  const fills = (fillRows ?? []) as RevalueFill[];
  const fundEvents = ((fundRows ?? []) as Array<{ amount: number | string | null; created_at: string }>).map(
    (r) => ({ at: r.created_at, amount: r.amount }),
  );


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

  // Positions settle in their listing currency; the snapshot is denominated in
  // the portfolio's base currency, so convert once per distinct currency.
  // Historical days can hold legs that are no longer in `holdings` (a position
  // opened and closed inside the window), so the fills ledger has to seed the
  // currency set too — otherwise that leg silently converts at 1.0.
  const base = String((portfolio as { currency?: string | null }).currency ?? "GBP").toUpperCase();
  const fx = new Map<string, number>();
  const { getFxRate } = await import("./fx.server");
  const currencies = new Set<string>([
    ...holdings.map((h) => instrumentCurrency(h).toUpperCase()),
    ...fills.map((f) => instrumentCurrency({ symbol: String(f.symbol), quantity: 0 }).toUpperCase()),
  ]);
  for (const ccy of currencies) {

    if (ccy === base) {
      fx.set(ccy, 1);
      continue;
    }
    try {
      const res = await getFxRate(ccy, base);
      if (res && Number.isFinite(res.rate) && res.rate > 0) fx.set(ccy, res.rate);
    } catch {
      // Leave unset — valuation falls back to 1x rather than zeroing a leg.
    }
  }

  const report = planHistoricalRevaluation({
    portfolioId,
    snapshots,
    holdings,
    fills,
    prices,
    inception,
    fx,
    baseCcy: base,

    fundEvents,
    today: options.today ?? new Date().toISOString().slice(0, 10),
  });

  if (dryRun || report.rows.length === 0) {
    return { ...report, written: 0, dryRun };
  }

  // Revaluation rewrites a whole historical series, so the prior total for
  // each row comes from the series itself rather than a per-row query.
  const ordered = [...report.rows].sort((a, b) =>
    a.snapshot_date < b.snapshot_date ? -1 : a.snapshot_date > b.snapshot_date ? 1 : 0,
  );
  const { written, rejected } = await writeEquitySnapshots(
    supabase as never,
    ordered.map((r, i) => ({
      portfolioId,
      snapshotDate: r.snapshot_date,
      cash: r.cash,
      holdingsValue: r.holdings_value,
      totalValue: r.total_value,
      currency: base,
      source: "revalue" as const,
      priorTotal: i === 0 ? null : ordered[i - 1]!.total_value,
    })),
  );

  return {
    ...report,
    written,
    dryRun,
    ...(rejected.length
      ? { error: `${rejected.length} row(s) rejected by the valuation gate: ${rejected[0]!.message ?? ""}` }
      : {}),
  };
}
