// Server-side driver for hourly equity backfill.
import type { SupabaseClient } from "@supabase/supabase-js";
import { deriveIntradayAnchors, type IntradayRow } from "./equity-intraday-backfill";
import {
  deriveIntradayFromPrices,
  reconstructQuantitiesByDay,
  type PriceObs,
  type TradeLite,
} from "./equity-intraday-price-shape";
import { portfolioInceptionDate } from "./portfolio-inception";

export type IntradayBackfillResult = {
  portfolioId: string;
  snapshots: number;
  rowsWritten: number;
  /** Of `rowsWritten`, how many came from real intraday prices (vs one-a-day anchors). */
  priceShapedRows?: number;
  fromBucket: string | null;
  toBucket: string | null;
  skipped?: string;
};

const CHUNK = 500;

export async function backfillPortfolioIntradayEquity(
  supabase: SupabaseClient,
  portfolioId: string,
  days: number,
  now: Date = new Date(),
): Promise<IntradayBackfillResult> {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - Math.max(1, days));
  let cutoffDate = cutoff.toISOString().slice(0, 10);

  // Never seed hours from before the portfolio existed / went live.
  const { data: pf } = await supabase
    .from("portfolios")
    .select("created_at, live_activated_at")
    .eq("id", portfolioId)
    .maybeSingle();
  const inception = portfolioInceptionDate(pf as never);
  if (inception && inception > cutoffDate) cutoffDate = inception;

  const { data: snaps, error: snapErr } = await supabase
    .from("equity_snapshots")
    .select("snapshot_date, cash, holdings_value, total_value")
    .eq("portfolio_id", portfolioId)
    .gte("snapshot_date", cutoffDate)
    .order("snapshot_date", { ascending: true });
  if (snapErr) throw snapErr;

  const { data: existing, error: exErr } = await supabase
    .from("equity_intraday")
    .select("bucket_hour")
    .eq("portfolio_id", portfolioId)
    .gte("bucket_hour", cutoff.toISOString());
  if (exErr) throw exErr;

  const existingBuckets = (existing ?? []).map((r) =>
    String((r as { bucket_hour: unknown }).bucket_hour),
  );

  // Real intraday shape first: where hourly prices were recorded for the
  // symbols held that day, a historical day gets many points instead of one.
  const { data: holdings } = await supabase
    .from("holdings")
    .select("symbol, quantity")
    .eq("portfolio_id", portfolioId);
  const currentQty = new Map<string, number>(
    (holdings ?? [])
      .map((h) => [String(h.symbol), Number(h.quantity)] as const)
      .filter(([, q]) => Number.isFinite(q) && q > 0),
  );

  let priceRows: IntradayRow[] = [];
  if (currentQty.size > 0) {
    const [{ data: trades }, { data: pxRows }] = await Promise.all([
      supabase
        .from("trades")
        .select("symbol, side, quantity, executed_at")
        .eq("portfolio_id", portfolioId)
        .gte("trade_date", cutoffDate)
        .order("executed_at", { ascending: true }),
      supabase
        .from("price_intraday")
        .select("symbol, bucket_hour, price")
        .in("symbol", [...currentQty.keys()])
        .gte("bucket_hour", cutoff.toISOString())
        .order("bucket_hour", { ascending: true }),
    ]);

    if ((pxRows ?? []).length > 0) {
      const days = (snaps ?? []).map((s) => String(s.snapshot_date).slice(0, 10));
      const qtyByDay = reconstructQuantitiesByDay(
        currentQty,
        (trades ?? []) as TradeLite[],
        days,
      );
      priceRows = deriveIntradayFromPrices(
        portfolioId,
        (snaps ?? []) as never[],
        (pxRows ?? []) as PriceObs[],
        qtyByDay,
        existingBuckets,
        now,
      );
    }
  }

  // Anchors fill in every day the price history could not shape.
  const anchors = deriveIntradayAnchors(
    portfolioId,
    (snaps ?? []) as never[],
    [...existingBuckets, ...priceRows.map((r) => r.bucket_hour)],
    now,
  );

  const rows = [...priceRows, ...anchors].sort((a, b) =>
    a.bucket_hour.localeCompare(b.bucket_hour),
  );

  if (rows.length === 0) {
    return {
      portfolioId,
      snapshots: snaps?.length ?? 0,
      rowsWritten: 0,
      priceShapedRows: 0,
      fromBucket: null,
      toBucket: null,
      skipped: (snaps?.length ?? 0) === 0 ? "no-snapshots" : "already-backfilled",
    };
  }


  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk: IntradayRow[] = rows.slice(i, i + CHUNK);
    // Derived anchors must never clobber a genuinely recorded hour, hence
    // ignoreDuplicates rather than an overwriting upsert.
    const { error } = await supabase
      .from("equity_intraday")
      .upsert(chunk, { onConflict: "portfolio_id,bucket_hour", ignoreDuplicates: true });
    if (error) throw error;
    written += chunk.length;
  }

  return {
    portfolioId,
    snapshots: snaps?.length ?? 0,
    rowsWritten: written,
    fromBucket: rows[0].bucket_hour,
    toBucket: rows[rows.length - 1].bucket_hour,
  };
}
