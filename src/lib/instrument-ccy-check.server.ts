// Server driver for the instrument-currency / price-unit consistency check.
//
// Loads exactly what the valuation path loads — holdings, the most recent
// usable close per symbol from `price_cache`, live FX, and the latest stored
// snapshot — then replays them through the pure checker.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  instrumentCurrency,
  symbolKeys,
  type RevalueHolding,
} from "./equity-snapshot-revalue";
import {
  checkInstrumentCurrencies,
  type InstrumentCcyCheckReport,
  type RecentQuote,
} from "./instrument-ccy-check";

export type InstrumentCcyCheckResult = InstrumentCcyCheckReport & { error?: string };

/** Most recent close per holding symbol, resolved across every spelling. */
async function loadRecentQuotes(
  supabase: SupabaseClient,
  holdings: RevalueHolding[],
  lookbackDays: number,
): Promise<Map<string, RecentQuote>> {
  const out = new Map<string, RecentQuote>();
  const wanted = new Map<string, string[]>();
  for (const h of holdings) {
    const symbol = String(h.symbol ?? "");
    if (symbol) wanted.set(symbol, symbolKeys(symbol));
  }
  if (wanted.size === 0) return out;

  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const { data } = await supabase
    .from("price_cache")
    .select("symbol, price_date, close")
    .gte("price_date", since)
    .order("price_date", { ascending: true });

  const series = new Map<string, RecentQuote>();
  for (const row of data ?? []) {
    const key = String((row as { symbol: unknown }).symbol ?? "").toUpperCase();
    const close = Number((row as { close: unknown }).close);
    if (!key || !Number.isFinite(close) || close <= 0) continue;
    const date = String((row as { price_date: unknown }).price_date).slice(0, 10);
    const prev = series.get(key);
    if (!prev || date >= prev.date) series.set(key, { close, date });
  }

  for (const [symbol, keys] of wanted) {
    for (const key of keys) {
      const hit = series.get(key);
      if (hit) {
        out.set(symbol, hit);
        break;
      }
    }
  }
  return out;
}

export async function runInstrumentCcyCheck(
  supabase: SupabaseClient,
  portfolioId: string,
  options: { lookbackDays?: number } = {},
): Promise<InstrumentCcyCheckResult> {
  const lookback = options.lookbackDays ?? 21;

  const [{ data: portfolio }, { data: holdingRows }, { data: snapshotRow }] = await Promise.all([
    supabase.from("portfolios").select("id, currency").eq("id", portfolioId).maybeSingle(),
    supabase
      .from("holdings")
      .select("symbol, quantity, avg_cost, asset_class, opened_at, instrument_ccy")
      .eq("portfolio_id", portfolioId)
      .gt("quantity", 0),
    supabase
      .from("equity_snapshots")
      .select("snapshot_date, holdings_value")
      .eq("portfolio_id", portfolioId)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const base = String(
    (portfolio as { currency?: string | null } | null)?.currency ?? "GBP",
  ).toUpperCase();

  if (!portfolio) {
    return {
      portfolio_id: portfolioId,
      base_ccy: base,
      checked: 0,
      findings: [],
      snapshot: null,
      snapshot_ratio: null,
      summary: "Portfolio not found.",
      error: "portfolio not found",
    };
  }

  const holdings = (holdingRows ?? []) as RevalueHolding[];
  const quotes = await loadRecentQuotes(supabase, holdings, lookback);

  const fx = new Map<string, number>();
  const { getFxRate } = await import("./fx.server");
  const currencies = new Set<string>();
  for (const h of holdings) {
    currencies.add(instrumentCurrency(h).toUpperCase());
    const declared = String(h.instrument_ccy ?? "").trim().toUpperCase();
    if (declared && declared !== "GBX") currencies.add(declared);
  }
  for (const ccy of currencies) {
    if (ccy === base) {
      fx.set(ccy, 1);
      continue;
    }
    try {
      const res = await getFxRate(ccy, base);
      if (res && Number.isFinite(res.rate) && res.rate > 0) fx.set(ccy, res.rate);
    } catch {
      // Unknown rate — the checker reports the leg rather than inventing 1.0.
    }
  }

  const snapshot = snapshotRow
    ? {
        date: String((snapshotRow as { snapshot_date: unknown }).snapshot_date).slice(0, 10),
        holdings_value: (snapshotRow as { holdings_value: number | string | null }).holdings_value,
      }
    : null;

  return checkInstrumentCurrencies({
    portfolioId,
    baseCcy: base,
    holdings,
    quotes,
    fx,
    snapshot,
  });
}
