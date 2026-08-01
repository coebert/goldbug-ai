// One-off historical revaluation through the valuation kernel.
//
// `equity-snapshot-revalue.server.ts` fixes history with the older pure
// planner (its own units + a single FX multiplier per currency). This job is
// the kernel equivalent: every historical day is rebuilt through
// `valuePortfolioHoldings`, so the same units rules, observed quote
// currencies, FX resolution and provenance capture that produce *today's*
// number also produce every number behind it.
//
// Per portfolio, per stored snapshot date (oldest first):
//   1. reconstruct the position book for that day by rolling current holdings
//      backwards through the fills ledger (`positionsOn`)
//   2. mark each position to that day's close, carried forward from the most
//      recent earlier close in `price_cache`
//   3. run the kernel with cash from the stored row (cash is external truth)
//   4. persist through the write gate with `source: "revalue"`, chaining
//      `priorTotal` from the series so the plausibility band judges the
//      recomputed sequence rather than the old, wrong one
//
// Idempotent: rows already equal to the recomputation are skipped, and a
// re-run recomputes the same values from the same inputs.
//
// Caveat, deliberately accepted: FX uses current spot, not the historical
// rate for each day. Same-day FX history is not stored, and using today's rate
// consistently keeps the series internally comparable.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  closeOnOrBefore,
  positionsOn,
  symbolKeys,
  type RevalueFill,
  type RevalueHolding,
} from "../equity-snapshot-revalue";
import { normalizeLseDisplayPriceToBase } from "../market-price-units";
import { valuePortfolioHoldings } from "./value-holdings.server";
import { writeEquitySnapshot } from "./write-snapshot.server";
import type { KernelHolding } from "./kernel";

/** Values closer than this are treated as unchanged, so no write is issued. */
export const UNCHANGED_EPSILON = 0.01;

export type BackfillDayResult = {
  snapshotDate: string;
  previousTotal: number;
  total: number;
  cash: number;
  holdingsValue: number;
  ratio: number | null;
  degraded: boolean;
  warnings: string[];
  status: "written" | "unchanged" | "rejected" | "dry_run";
  message?: string;
};

export type PortfolioBackfillResult = {
  portfolioId: string;
  portfolioName: string;
  baseCurrency: string;
  daysScanned: number;
  written: number;
  unchanged: number;
  rejected: number;
  /** Largest old/new ratio seen — ~100 is the classic GBX/GBP inflation. */
  worstRatio: number | null;
  days: BackfillDayResult[];
  error?: string;
};

export type BackfillRunResult = {
  dryRun: boolean;
  portfolios: PortfolioBackfillResult[];
  totals: { daysScanned: number; written: number; unchanged: number; rejected: number };
};

type SnapshotRow = {
  snapshot_date: string;
  cash: number | string | null;
  holdings_value: number | string | null;
  total_value: number | string | null;
};

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Full daily close history for every spelling of the given symbols. */
export async function loadCloseHistory(
  supabase: SupabaseClient,
  symbols: string[],
  since: string,
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  const wanted = new Set(symbols.flatMap((s) => symbolKeys(s)));
  if (wanted.size === 0) return out;

  const { data } = await supabase
    .from("price_cache")
    .select("symbol, price_date, close")
    .in("symbol", [...wanted])
    .gte("price_date", since)
    .order("price_date", { ascending: true });

  for (const row of data ?? []) {
    const symbol = String((row as { symbol: unknown }).symbol ?? "").toUpperCase();
    if (!wanted.has(symbol)) continue;
    const close = num((row as { close: unknown }).close, NaN);
    if (!Number.isFinite(close) || close <= 0) continue;
    const date = String((row as { price_date: unknown }).price_date).slice(0, 10);
    const series = out.get(symbol) ?? new Map<string, number>();
    series.set(date, close);
    out.set(symbol, series);
  }
  return out;
}

/**
 * Pure per-day input builder: the reconstructed book plus the price map the
 * kernel adapter expects (already in the instrument's MAJOR unit, never
 * FX-converted). Exported so the day maths can be tested without a database.
 */
export function buildDayValuationInputs(
  book: Map<string, { quantity: number; holding: RevalueHolding }>,
  prices: Map<string, Map<string, number>>,
  date: string,
): { holdings: KernelHolding[]; normalizedPrices: Map<string, number> } {
  const holdings: KernelHolding[] = [];
  const normalizedPrices = new Map<string, number>();

  for (const { quantity, holding } of book.values()) {
    const symbol = String(holding.symbol);
    holdings.push({
      symbol,
      quantity,
      instrument_ccy: holding.instrument_ccy ?? null,
      avg_cost: holding.avg_cost ?? null,
      asset_class: holding.asset_class ?? null,
    });
    const raw = closeOnOrBefore(prices, symbol, date);
    if (raw == null) continue;
    // Fold pence quotes to pounds exactly once; the adapter is told prices are
    // already in major units so the kernel will not divide again.
    const major = normalizeLseDisplayPriceToBase(symbol, raw, holding.asset_class ?? null);
    if (major > 0) normalizedPrices.set(symbol.toUpperCase(), major);
  }

  return { holdings, normalizedPrices };
}

async function backfillPortfolio(
  supabase: SupabaseClient,
  portfolio: { id: string; name: string; currency: string; cash: number },
  options: { dryRun: boolean; since?: string },
): Promise<PortfolioBackfillResult> {
  const portfolioId = portfolio.id;
  const base = (portfolio.currency || "GBP").toUpperCase();
  const result: PortfolioBackfillResult = {
    portfolioId,
    portfolioName: portfolio.name,
    baseCurrency: base,
    daysScanned: 0,
    written: 0,
    unchanged: 0,
    rejected: 0,
    worstRatio: null,
    days: [],
  };

  let snapshotQuery = supabase
    .from("equity_snapshots")
    .select("snapshot_date, cash, holdings_value, total_value")
    .eq("portfolio_id", portfolioId)
    .order("snapshot_date", { ascending: true });
  if (options.since) snapshotQuery = snapshotQuery.gte("snapshot_date", options.since);

  const [{ data: snapshotRows }, { data: holdingRows }, { data: fillRows }] = await Promise.all([
    snapshotQuery,
    supabase
      .from("holdings")
      .select("symbol, quantity, avg_cost, asset_class, opened_at, instrument_ccy")
      .eq("portfolio_id", portfolioId)
      .gt("quantity", 0),
    supabase
      .from("live_fills")
      .select("symbol, side, quantity, filled_at")
      .eq("portfolio_id", portfolioId)
      .order("filled_at", { ascending: true }),
  ]);

  const snapshots = (snapshotRows ?? []) as SnapshotRow[];
  if (snapshots.length === 0) return result;
  const holdings = (holdingRows ?? []) as RevalueHolding[];
  const fills = (fillRows ?? []) as RevalueFill[];

  const prices = await loadCloseHistory(
    supabase,
    [...holdings.map((h) => String(h.symbol)), ...fills.map((f) => String(f.symbol))],
    String(snapshots[0]!.snapshot_date).slice(0, 10),
  );

  // Prior total for the band check comes from the recomputed series, not the
  // stored (possibly inflated) one — otherwise correcting a 100x day would
  // itself look like an implausible move.
  let priorTotal: number | null = null;

  for (const snap of snapshots) {
    const date = String(snap.snapshot_date).slice(0, 10);
    result.daysScanned += 1;

    const book = positionsOn(holdings, fills, date);
    const { holdings: dayHoldings, normalizedPrices } = buildDayValuationInputs(book, prices, date);
    // Cash is external truth: preserve whatever the stored row recorded.
    const cash = num(snap.cash);

    const valued = await valuePortfolioHoldings({
      holdings: dayHoldings,
      normalizedPrices,
      wallet: { [base]: cash },
      baseCcy: base,
      asOf: date,
      allowCostBasisFallback: true,
    });

    const previousTotal = num(snap.total_value);
    const total = valued.totalValue;
    const ratio = total > 0 && previousTotal > 0 ? previousTotal / total : null;
    if (ratio != null && (result.worstRatio == null || ratio > result.worstRatio)) {
      result.worstRatio = ratio;
    }

    const day: BackfillDayResult = {
      snapshotDate: date,
      previousTotal,
      total,
      cash: valued.cash,
      holdingsValue: valued.holdingsValue,
      ratio,
      degraded: valued.provenance.degraded,
      warnings: [...new Set(valued.provenance.warnings.map((w) => w.code))],
      status: "unchanged",
    };

    const unchanged =
      Math.abs(previousTotal - total) < UNCHANGED_EPSILON &&
      Math.abs(num(snap.holdings_value) - valued.holdingsValue) < UNCHANGED_EPSILON;

    if (unchanged) {
      result.unchanged += 1;
      priorTotal = total;
      result.days.push(day);
      continue;
    }

    if (options.dryRun) {
      day.status = "dry_run";
      result.days.push(day);
      priorTotal = total;
      continue;
    }

    const write = await writeEquitySnapshot(supabase as never, {
      portfolioId,
      snapshotDate: date,
      cash: valued.cash,
      holdingsValue: valued.holdingsValue,
      totalValue: total,
      currency: base,
      source: "revalue",
      provenance: valued.provenance,
      priorTotal,
    });

    if (write.written) {
      day.status = "written";
      result.written += 1;
      priorTotal = total;
    } else {
      day.status = "rejected";
      day.message = write.message;
      result.rejected += 1;
      // Keep the stored figure as the baseline so one rejection does not
      // cascade into rejecting every later day.
      priorTotal = previousTotal || priorTotal;
    }
    result.days.push(day);
  }

  return result;
}

/**
 * Revalue the full stored history for one portfolio, or for every portfolio
 * when `portfolioIds` is omitted.
 */
export async function backfillValuationHistory(
  supabase: SupabaseClient,
  options: { portfolioIds?: string[]; dryRun?: boolean; since?: string } = {},
): Promise<BackfillRunResult> {
  const dryRun = options.dryRun === true;

  let query = supabase.from("portfolios").select("id, name, currency, cash");
  if (options.portfolioIds?.length) query = query.in("id", options.portfolioIds);
  const { data: portfolioRows, error } = await query;

  const portfolios: PortfolioBackfillResult[] = [];

  for (const p of portfolioRows ?? []) {
    const row = p as { id: unknown; name?: unknown; currency?: unknown; cash?: unknown };
    try {
      portfolios.push(
        await backfillPortfolio(
          supabase,
          {
            id: String(row.id),
            name: String(row.name ?? "Portfolio"),
            currency: String(row.currency ?? "GBP"),
            cash: num(row.cash),
          },
          { dryRun, since: options.since },
        ),
      );
    } catch (e) {
      portfolios.push({
        portfolioId: String(row.id),
        portfolioName: String(row.name ?? "Portfolio"),
        baseCurrency: String(row.currency ?? "GBP").toUpperCase(),
        daysScanned: 0,
        written: 0,
        unchanged: 0,
        rejected: 0,
        worstRatio: null,
        days: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const totals = portfolios.reduce(
    (acc, p) => ({
      daysScanned: acc.daysScanned + p.daysScanned,
      written: acc.written + p.written,
      unchanged: acc.unchanged + p.unchanged,
      rejected: acc.rejected + p.rejected,
    }),
    { daysScanned: 0, written: 0, unchanged: 0, rejected: 0 },
  );

  if (error && portfolios.length === 0) {
    return { dryRun, portfolios: [], totals };
  }
  return { dryRun, portfolios, totals };
}
