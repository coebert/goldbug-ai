// Loader for the broker-sync data-quality report.
//
// Runs under the caller's Supabase client, so RLS scopes every read to the
// portfolios they own.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { instrumentCurrency } from "./equity-snapshot-revalue";
import {
  buildPortfolioDataQuality,
  summariseDataQuality,
  type DataQualityReport,
  type DqFill,
  type DqHolding,
} from "./data-quality-report";

const FILL_PAGE = 1000;

async function loadFills(
  db: SupabaseClient<Database>,
  portfolioId: string,
): Promise<DqFill[]> {
  const out: DqFill[] = [];
  for (let from = 0; ; from += FILL_PAGE) {
    const page = await db
      .from("live_fills")
      .select("symbol, side, quantity, fill_price, filled_at")
      .eq("portfolio_id", portfolioId)
      .order("filled_at", { ascending: true })
      .range(from, from + FILL_PAGE - 1);
    if (page.error) throw new Error(page.error.message);
    const rows = page.data ?? [];
    for (const r of rows) {
      out.push({
        symbol: String(r.symbol),
        side: (r.side as string | null) ?? null,
        quantity: r.quantity as number | null,
        fill_price: r.fill_price as number | null,
        filled_at: String(r.filled_at),
      });
    }
    if (rows.length < FILL_PAGE) break;
  }
  return out;
}

/** Instrument currency → base currency multipliers for one portfolio. */
async function loadFx(
  holdings: DqHolding[],
  fills: DqFill[],
  base: string,
): Promise<Map<string, number>> {
  const fx = new Map<string, number>();
  const currencies = new Set<string>([
    ...holdings.map((h) =>
      instrumentCurrency({
        symbol: String(h.symbol),
        quantity: 0,
        instrument_ccy: h.instrument_ccy ?? null,
      }).toUpperCase(),
    ),
    ...fills.map((f) =>
      instrumentCurrency({ symbol: String(f.symbol), quantity: 0 }).toUpperCase(),
    ),
  ]);
  const { getFxRate } = await import("./fx.server");
  for (const ccy of currencies) {
    if (!ccy) continue;
    if (ccy === base) {
      fx.set(ccy, 1);
      continue;
    }
    try {
      const res = await getFxRate(ccy, base);
      const rate = Number(res?.rate);
      fx.set(ccy, Number.isFinite(rate) && rate > 0 ? rate : 1);
    } catch {
      fx.set(ccy, 1);
    }

  }
  return fx;
}

export async function buildDataQualityReport(params: {
  db: SupabaseClient<Database>;
  userId: string;
  portfolioId?: string;
}): Promise<DataQualityReport> {
  const { db, userId } = params;

  let pfQuery = db
    .from("portfolios")
    .select("id, name, mode, currency, current_cash")
    .eq("user_id", userId);
  if (params.portfolioId) pfQuery = pfQuery.eq("id", params.portfolioId);
  const pf = await pfQuery;
  if (pf.error) throw new Error(pf.error.message);

  const reports = [];
  for (const p of pf.data ?? []) {
    const portfolioId = p.id as string;
    const base = String((p.currency as string | null) ?? "GBP").toUpperCase();

    const [holdRes, snapRes, fundRes, fills] = await Promise.all([
      db
        .from("holdings")
        .select("symbol, quantity, avg_cost, instrument_ccy, opened_at")
        .eq("portfolio_id", portfolioId)
        .gt("quantity", 0),
      db
        .from("equity_snapshots")
        .select("snapshot_date, cash, total_value")
        .eq("portfolio_id", portfolioId)
        .order("snapshot_date", { ascending: true }),
      db
        .from("sim_fund_events")
        .select("amount, created_at")
        .eq("portfolio_id", portfolioId),
      loadFills(db, portfolioId),
    ]);
    if (holdRes.error) throw new Error(holdRes.error.message);
    if (snapRes.error) throw new Error(snapRes.error.message);

    const holdings = (holdRes.data ?? []) as DqHolding[];
    const fx = await loadFx(holdings, fills, base);

    reports.push(
      buildPortfolioDataQuality({
        portfolioId,
        portfolioName: (p.name as string | null) ?? "Portfolio",
        mode: (p.mode as string | null) ?? null,
        baseCcy: base,
        holdings,
        fills,
        snapshots: (snapRes.data ?? []).map((s) => ({
          snapshot_date: String(s.snapshot_date),
          cash: s.cash as number | null,
          total_value: s.total_value as number | null,
        })),
        fundEvents: (fundRes.data ?? []).map((e) => ({
          at: String(e.created_at),
          amount: e.amount as number | null,
        })),
        portfolioCash: (p.current_cash as number | null) ?? null,
        fx,
      }),
    );
  }

  return summariseDataQuality(reports);
}
