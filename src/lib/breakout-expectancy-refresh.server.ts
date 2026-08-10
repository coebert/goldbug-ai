// Automatic recomputation of the breakout expectancy table.
//
// Runs weekly from cron. It replays the breakout detector over two rolling
// windows of daily history (a recent 12-month window and a longer 36-month
// one), pools them with recency weighting, sanity-gates the result, and — only
// if the candidate passes — publishes it as the table the LIVE regime gate
// reads on the next trading run.
//
// Design notes:
//   * Every run is recorded, published or not. A rejected candidate leaves the
//     previous table in force; the gate never runs on an unvetted table.
//   * The pooled sample counts are raw observations, so a fresh table cannot
//     make a thin cell look "proven" to the gate.
//   * Price data is global reference data (price_cache), so the admin client is
//     used for reads only after the caller has already been verified by the
//     cron helper.

import {
  runBreakoutBacktest,
  type BacktestBar,
  type SymbolBars,
} from "@/lib/breakout-backtest";
import {
  diffExpectancyTables,
  mergeExpectancyWindows,
  validateExpectancyTable,
  type ExpectancyWindow,
} from "@/lib/breakout-expectancy-refresh";
import { loadLiveExpectancyTable, invalidateLiveExpectancyCache } from "@/lib/breakout-expectancy-store.server";
import { ukDayKey } from "@/lib/uk-time";

/** Liquid, deeply-quoted names with long price_cache history. */
export const EXPECTANCY_REFRESH_SYMBOLS = [
  "SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL",
  "META", "JPM", "XOM", "GLD", "TLT", "VOO",
] as const;

export type RefreshWindowSpec = { label: string; days: number; weight: number };

export const DEFAULT_REFRESH_WINDOWS: RefreshWindowSpec[] = [
  { label: "12m", days: 365, weight: 2 },
  { label: "36m", days: 1095, weight: 1 },
];

export type ExpectancyRefreshResult = {
  status: "published" | "rejected";
  totalTrades: number;
  symbols: string[];
  skippedSymbols: string[];
  windows: { label: string; days: number; weight: number; from: string | null; to: string | null; trades: number }[];
  reasons: string[];
  droppedCells: string[];
  diffSummary: string;
  signFlips: string[];
  cells: unknown;
  runId: string | null;
};

async function loadSeries(
  symbols: readonly string[],
  fromDate: string,
): Promise<{ series: SymbolBars[]; skipped: string[] }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const series: SymbolBars[] = [];
  const skipped: string[] = [];
  for (const symbol of symbols) {
    const { data: rows, error } = await supabaseAdmin
      .from("price_cache")
      .select("price_date, high, low, close, volume")
      .eq("symbol", symbol)
      .gte("price_date", fromDate)
      .order("price_date", { ascending: true });
    if (error) throw new Error(`price_cache read failed for ${symbol}: ${error.message}`);
    const bars: BacktestBar[] = (rows ?? [])
      .filter((r) => r.high != null && r.low != null && r.close != null)
      .map((r) => ({
        date: r.price_date as string,
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: r.volume == null ? null : Number(r.volume),
      }));
    if (bars.length < 150) {
      skipped.push(symbol);
      continue;
    }
    series.push({ symbol, bars });
  }
  return { series, skipped };
}

function sliceSeries(series: readonly SymbolBars[], fromDate: string): SymbolBars[] {
  return series
    .map((s) => ({ symbol: s.symbol, bars: s.bars.filter((b) => b.date >= fromDate) }))
    .filter((s) => s.bars.length >= 150);
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Recompute the expectancy table from the latest backtest windows and, if it
 * passes the guardrails, publish it for the live gate.
 */
export async function refreshBreakoutExpectancy(options?: {
  symbols?: readonly string[];
  windows?: RefreshWindowSpec[];
  triggeredBy?: string;
  /** Compute and record, but never publish (used for dry runs). */
  dryRun?: boolean;
}): Promise<ExpectancyRefreshResult> {
  const symbols = (options?.symbols ?? EXPECTANCY_REFRESH_SYMBOLS).map((s) => s.toUpperCase());
  const windowSpecs = options?.windows ?? DEFAULT_REFRESH_WINDOWS;
  const maxDays = Math.max(...windowSpecs.map((w) => w.days));

  const { series, skipped } = await loadSeries(symbols, daysAgo(maxDays + 200));
  if (!series.length) throw new Error("No symbol had enough daily history to refresh expectancy.");

  const windows: ExpectancyWindow[] = [];
  const windowMeta: ExpectancyRefreshResult["windows"] = [];
  for (const spec of windowSpecs) {
    const sliced = sliceSeries(series, daysAgo(spec.days));
    if (!sliced.length) {
      windowMeta.push({ ...spec, from: null, to: null, trades: 0 });
      continue;
    }
    const report = runBreakoutBacktest(sliced);
    windows.push({
      label: spec.label,
      weight: spec.weight,
      from: report.from,
      to: report.to,
      stats: report.stats,
    });
    windowMeta.push({
      ...spec,
      from: report.from,
      to: report.to,
      trades: report.trades.length,
    });
  }

  const asOf = ukDayKey(new Date());
  const candidate = mergeExpectancyWindows(windows, {
    source: `auto-refresh ${asOf} (${series.length} symbols; ${windowSpecs
      .map((w) => `${w.label}x${w.weight}`)
      .join(" + ")})`,
    asOf,
  });

  const validation = validateExpectancyTable(candidate);
  const previous = await loadLiveExpectancyTable();
  const diff = diffExpectancyTables(previous, validation.table);
  const status: "published" | "rejected" =
    validation.ok && !options?.dryRun ? "published" : "rejected";
  const reasons = validation.ok
    ? options?.dryRun
      ? ["dry run — candidate not published"]
      : []
    : validation.reasons;

  let runId: string | null = null;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("breakout_expectancy_runs")
      .insert({
        status,
        source: validation.table.source,
        as_of: asOf,
        cells: validation.table.cells as never,
        total_trades: validation.totalTrades,
        symbols: series.map((s) => s.symbol),
        windows: windowMeta as never,
        diff: {
          summary: diff.summary,
          signFlips: diff.signFlips.map((c) => `${c.cohort}/${c.bucket}`),
          changed: diff.changed.map((c) => ({
            cell: `${c.cohort}/${c.bucket}`,
            before: c.before,
            after: c.after,
            deltaExpectancyPct: c.deltaExpectancyPct,
          })),
        } as never,
        reasons,
        dropped_cells: validation.droppedCells,
        triggered_by: options?.triggeredBy ?? "cron",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    runId = data?.id ?? null;
  } catch (e) {
    console.error("breakout expectancy refresh: persist failed", e);
  }

  if (status === "published") invalidateLiveExpectancyCache();

  return {
    status,
    totalTrades: validation.totalTrades,
    symbols: series.map((s) => s.symbol),
    skippedSymbols: skipped,
    windows: windowMeta,
    reasons,
    droppedCells: validation.droppedCells,
    diffSummary: diff.summary,
    signFlips: diff.signFlips.map((c) => `${c.cohort}/${c.bucket}`),
    cells: validation.table.cells,
    runId,
  };
}
