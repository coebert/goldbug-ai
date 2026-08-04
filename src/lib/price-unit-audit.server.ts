// Server driver for the price-unit audit trail.
//
// Loads exactly the same inputs the valuation path uses (holdings, fills,
// price_cache closes, live FX, the stored snapshot for the day) and replays
// them through the pure auditor.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  instrumentCurrency,
  symbolKeys,
  type RevalueFill,
  type RevalueHolding,
} from "./equity-snapshot-revalue";
import { auditPriceUnits, type PriceUnitAudit } from "./price-unit-audit";

export type PriceUnitAuditResult = PriceUnitAudit & { error?: string };

async function loadPrices(
  supabase: SupabaseClient,
  symbols: string[],
  until: string,
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  const wanted = new Set(symbols.flatMap((s) => symbolKeys(s)));
  if (wanted.size === 0) return out;

  const { data } = await supabase
    .from("price_cache")
    .select("symbol, price_date, close")
    .lte("price_date", until)
    .order("price_date", { ascending: true });

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

export async function buildPriceUnitAudit(
  supabase: SupabaseClient,
  portfolioId: string,
  date: string,
): Promise<PriceUnitAuditResult> {
  const day = String(date).slice(0, 10);
  const empty: PriceUnitAuditResult = {
    portfolio_id: portfolioId,
    date: day,
    base_ccy: "GBP",
    rows: [],
    holdings_value: 0,
    cash: 0,
    total_value: 0,
    by_currency: [],
    stored: null,
    stored_ratio: null,
    warnings: [],
  };

  const [{ data: portfolio }, { data: holdingRows }, { data: fillRows }, { data: snapshot }] =
    await Promise.all([
      supabase.from("portfolios").select("id, currency").eq("id", portfolioId).maybeSingle(),
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
      supabase
        .from("equity_snapshots")
        .select("cash, holdings_value, total_value")
        .eq("portfolio_id", portfolioId)
        .eq("snapshot_date", day)
        .maybeSingle(),
    ]);

  if (!portfolio) return { ...empty, error: "portfolio not found" };

  const holdings = (holdingRows ?? []) as RevalueHolding[];
  const fills = (fillRows ?? []) as RevalueFill[];
  const base = String((portfolio as { currency?: string | null }).currency ?? "GBP").toUpperCase();

  const prices = await loadPrices(
    supabase,
    holdings.map((h) => String(h.symbol)).concat(fills.map((f) => String(f.symbol))),
    day,
  );

  const fx = new Map<string, number>();
  const { getFxRate } = await import("./fx.server");
  // Fill-only legs (opened and closed inside the audited window) are not in
  // `holdings`, so seed the currency set from the ledger as well. Without it
  // the audit reports "no rate found — 1.0 assumed" for e.g. a closed USD leg.
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
      // Leave unset — the auditor flags the leg rather than silently zeroing it.
    }
  }

  return auditPriceUnits({
    portfolioId,
    date: day,
    baseCcy: base,
    holdings,
    fills,
    prices,
    fx,
    cash: Number((snapshot as { cash?: unknown } | null)?.cash ?? 0),
    stored: snapshot as { holdings_value?: number | null; total_value?: number | null } | null,
  });
}
