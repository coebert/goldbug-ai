/**
 * Builds the training set for the learned decision model out of the account's
 * own recorded history.
 *
 * Source of truth: every row in `decisions` carries `raw.signals` — the full
 * per-symbol indicator snapshot the engine handed the AI on that date. Pairing
 * each snapshot with the realised forward return from `price_cache` gives a
 * clean, look-ahead-free panel of (features today -> what happened next).
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { priceSymbolVariants } from "../price-symbol";
import { extractFeatureVector, FEATURE_KEYS, type AnyRow } from "./features";
import type { Sample } from "./fit";

export type DatasetOptions = {
  userId: string;
  /** Forward-return horizon in trading days. */
  horizonDays?: number;
  /** Only use decisions from real-money books when true. */
  realMoneyOnly?: boolean;
};

export type DatasetResult = {
  samples: Sample[];
  dates: string[];
  symbols: string[];
  decisionsScanned: number;
  snapshotsScanned: number;
  skippedNoForwardPrice: number;
  horizonDays: number;
  from: string | null;
  to: string | null;
};

const REAL_MONEY_MODES = new Set(["live_prod", "live_sim"]);

/** Close prices for one symbol, ordered by date, keyed by the engine symbol. */
type PriceSeries = { dates: string[]; closes: number[] };

async function loadPriceSeries(symbols: string[], from: string): Promise<Map<string, PriceSeries>> {
  const out = new Map<string, PriceSeries>();
  // Query in chunks: the variant list can be several times the symbol count.
  const wanted = new Map<string, string>(); // cache symbol -> engine symbol
  for (const s of symbols) for (const v of priceSymbolVariants(s)) if (!wanted.has(v)) wanted.set(v, s);

  const keys = Array.from(wanted.keys());
  const CHUNK = 120;
  const rowsBySymbol = new Map<string, Array<{ d: string; c: number }>>();

  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    let page = 0;
    // Supabase caps rows per request; page until a short page comes back.
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from("price_cache")
        .select("symbol, price_date, close")
        .in("symbol", slice)
        .gte("price_date", from)
        .order("price_date", { ascending: true })
        .range(page * 1000, page * 1000 + 999);
      if (error) throw new Error(`price_cache read failed: ${error.message}`);
      for (const r of data ?? []) {
        const engine = wanted.get(r.symbol as string);
        if (!engine) continue;
        const close = Number(r.close);
        if (!Number.isFinite(close) || close <= 0) continue;
        const arr = rowsBySymbol.get(engine);
        const row = { d: r.price_date as string, c: close };
        if (arr) arr.push(row);
        else rowsBySymbol.set(engine, [row]);
      }
      if ((data?.length ?? 0) < 1000) break;
      page++;
    }
  }

  for (const [symbol, rows] of rowsBySymbol) {
    rows.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    // De-duplicate variants landing on the same date (keep the first seen).
    const dates: string[] = [];
    const closes: number[] = [];
    for (const r of rows) {
      if (dates[dates.length - 1] === r.d) continue;
      dates.push(r.d);
      closes.push(r.c);
    }
    out.set(symbol, { dates, closes });
  }
  return out;
}

/** Index of the first bar on or after `date`. */
function indexOnOrAfter(series: PriceSeries, date: string): number {
  let lo = 0;
  let hi = series.dates.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.dates[mid]! >= date) {
      ans = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return ans;
}

export async function buildDataset(opts: DatasetOptions): Promise<DatasetResult> {
  const horizonDays = Math.max(1, Math.min(20, opts.horizonDays ?? 5));

  const { data: portfolios, error: pErr } = await supabaseAdmin
    .from("portfolios")
    .select("id, mode")
    .eq("user_id", opts.userId);
  if (pErr) throw new Error(`portfolios read failed: ${pErr.message}`);

  const ids = (portfolios ?? [])
    .filter((p) => !opts.realMoneyOnly || REAL_MONEY_MODES.has((p.mode as string) ?? ""))
    .map((p) => p.id as string);
  if (ids.length === 0) {
    return {
      samples: [], dates: [], symbols: [], decisionsScanned: 0, snapshotsScanned: 0,
      skippedNoForwardPrice: 0, horizonDays, from: null, to: null,
    };
  }

  // Pull every decision snapshot, paging through the row cap.
  type DecRow = { run_date: string; raw: unknown };
  const decisions: DecRow[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from("decisions")
      .select("run_date, raw")
      .in("portfolio_id", ids)
      .order("run_date", { ascending: true })
      .range(page * 500, page * 500 + 499);
    if (error) throw new Error(`decisions read failed: ${error.message}`);
    decisions.push(...((data ?? []) as unknown as DecRow[]));
    if ((data?.length ?? 0) < 500) break;
  }

  // One snapshot per (date, symbol) — several portfolios tick the same day.
  const byKey = new Map<string, { date: string; symbol: string; row: AnyRow }>();
  let snapshotsScanned = 0;
  for (const d of decisions) {
    const raw = d.raw as { signals?: unknown } | null;
    const signals = Array.isArray(raw?.signals) ? (raw!.signals as AnyRow[]) : [];
    for (const s of signals) {
      const symbol = typeof s?.["symbol"] === "string" ? (s["symbol"] as string) : null;
      if (!symbol) continue;
      snapshotsScanned++;
      const key = `${d.run_date}|${symbol}`;
      if (!byKey.has(key)) byKey.set(key, { date: d.run_date, symbol, row: s });
    }
  }

  const symbols = Array.from(new Set(Array.from(byKey.values()).map((v) => v.symbol)));
  const allDates = Array.from(new Set(Array.from(byKey.values()).map((v) => v.date))).sort();
  const from = allDates[0] ?? null;

  const prices = from ? await loadPriceSeries(symbols, from) : new Map<string, PriceSeries>();

  const samples: Sample[] = [];
  let skippedNoForwardPrice = 0;
  for (const { date, symbol, row } of byKey.values()) {
    const series = prices.get(symbol);
    if (!series) {
      skippedNoForwardPrice++;
      continue;
    }
    const i0 = indexOnOrAfter(series, date);
    const i1 = i0 < 0 ? -1 : i0 + horizonDays;
    if (i0 < 0 || i1 >= series.dates.length) {
      skippedNoForwardPrice++;
      continue;
    }
    const p0 = series.closes[i0]!;
    const p1 = series.closes[i1]!;
    if (!(p0 > 0) || !(p1 > 0)) {
      skippedNoForwardPrice++;
      continue;
    }
    const y = p1 / p0 - 1;
    // Guard against unit switches / bad cache rows producing absurd returns.
    if (!Number.isFinite(y) || Math.abs(y) > 1) {
      skippedNoForwardPrice++;
      continue;
    }
    samples.push({ date, symbol, x: extractFeatureVector(row), y });
  }

  const usedDates = Array.from(new Set(samples.map((s) => s.date))).sort();
  return {
    samples,
    dates: usedDates,
    symbols,
    decisionsScanned: decisions.length,
    snapshotsScanned,
    skippedNoForwardPrice,
    horizonDays,
    from: usedDates[0] ?? null,
    to: usedDates[usedDates.length - 1] ?? null,
  };
}

export { FEATURE_KEYS };
