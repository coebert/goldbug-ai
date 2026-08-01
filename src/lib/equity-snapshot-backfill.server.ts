// Server driver for automatic equity-snapshot backfill.
//
// Runs on the equity read path so portfolio cards can never render an empty
// state (or fall back to raw cash) just because nobody happened to write a
// snapshot today. Every write is an idempotent upsert on
// (portfolio_id, snapshot_date), so concurrent readers converge.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  planMissingEquitySnapshots,
  type BackfillHolding,
  type BackfillPortfolio,
  type PlannedSnapshot,
} from "./equity-snapshot-backfill";
import { portfolioInceptionDate } from "./portfolio-inception";
import { priceSymbolVariants } from "./price-symbol";
import { instrumentCcyFor } from "./instrument-ccy-rules";
import { getFxRate } from "./fx.server";
import { writeEquitySnapshots } from "./valuation/write-snapshot.server";

export type BackfillPortfolioRow = {
  id: string;
  current_cash: number | string | null;
  created_at?: string | null;
  live_activated_at?: string | null;
  /** Reporting currency; foreign positions are converted into it. */
  currency?: string | null;
};

export type EquitySnapshotBackfillResult = {
  planned: PlannedSnapshot[];
  written: number;
  error?: string;
};

/** Latest close per symbol from `price_cache`, keyed uppercase. */
async function loadLatestPrices(
  supabase: SupabaseClient,
  symbols: string[],
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (symbols.length === 0) return prices;
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 14);
  const { data } = await supabase
    .from("price_cache")
    .select("symbol, price_date, close")
    .in("symbol", symbols)
    .gte("price_date", since.toISOString().slice(0, 10))
    .order("price_date", { ascending: true });
  for (const row of data ?? []) {
    const close = Number((row as { close: unknown }).close);
    if (!Number.isFinite(close) || close <= 0) continue;
    // Ascending order means the last write per symbol is the newest close.
    prices.set(String((row as { symbol: unknown }).symbol).toUpperCase(), close);
  }
  return prices;
}

export async function backfillMissingEquitySnapshots(
  supabase: SupabaseClient,
  portfolios: BackfillPortfolioRow[],
  today: string = new Date().toISOString().slice(0, 10),
): Promise<EquitySnapshotBackfillResult> {
  const ids = portfolios.map((p) => p.id);
  if (ids.length === 0) return { planned: [], written: 0 };

  try {
    const [{ data: snaps }, { data: holdingRows }] = await Promise.all([
      supabase
        .from("equity_snapshots")
        .select("portfolio_id, snapshot_date, cash, holdings_value, total_value")
        .in("portfolio_id", ids)
        .order("snapshot_date", { ascending: true }),
      supabase
        .from("holdings")
        .select("portfolio_id, symbol, quantity, avg_cost, asset_class, instrument_ccy")
        .in("portfolio_id", ids),
    ]);

    const holdings = (holdingRows ?? []) as unknown as BackfillHolding[];
    // price_cache is keyed by Yahoo-style tickers ("MKS.L") while holdings may
    // store broker-native MIC symbols ("MKS:xlon") — query both shapes.
    const symbols = [
      ...new Set(holdings.flatMap((h) => [String(h.symbol), ...priceSymbolVariants(String(h.symbol))])),
    ].filter(Boolean);
    const prices = await loadLatestPrices(supabase, symbols);

    // FX: value foreign positions in each portfolio's reporting currency.
    // Rates are resolved once per (from,to) pair; failures fall back to 1:1,
    // which is exactly the previous behaviour.
    const baseCcys = new Set(
      portfolios
        .map((p) => String(p.currency ?? "").toUpperCase())
        .filter(Boolean),
    );
    const quoteCcys = new Set(
      holdings
        .map((h) => {
          const tagged = String(h.instrument_ccy ?? "").toUpperCase();
          const ccy = tagged || instrumentCcyFor(String(h.symbol), null) || "";
          return ccy === "GBX" ? "GBP" : ccy;
        })
        .filter(Boolean),
    );
    const fxRates = new Map<string, number>();
    await Promise.all(
      [...baseCcys].flatMap((to) =>
        [...quoteCcys]
          .filter((from) => from !== to)
          .map(async (from) => {
            try {
              const r = await getFxRate(from, to);
              if (r && Number.isFinite(r.rate) && r.rate > 0) {
                fxRates.set(`${from}>${to}`, r.rate);
              }
            } catch {
              /* leave unset — valuation falls back to 1:1 */
            }
          }),
      ),
    );
    const fx = (from: string, to: string) => fxRates.get(`${from}>${to}`) ?? null;


    const planned = planMissingEquitySnapshots({
      portfolios: portfolios.map<BackfillPortfolio>((p) => ({
        id: p.id,
        current_cash: p.current_cash,
        inception: portfolioInceptionDate(p as never),
        currency: p.currency ?? null,
      })),
      snapshots: (snaps ?? []) as never,
      holdings,
      prices,
      today,
      fx,
    });

    if (planned.length === 0) return { planned, written: 0 };

    // Backfill fills gaps in a historical series, so the "previous total" for
    // the plausibility band is taken from the planned series itself (falling
    // back to whatever already exists on disk for the first row).
    const byPortfolio = new Map<string, typeof planned>();
    for (const row of planned) {
      const list = byPortfolio.get(row.portfolio_id) ?? [];
      list.push(row);
      byPortfolio.set(row.portfolio_id, list);
    }

    const currencyById = new Map(portfolios.map((p) => [p.id, p.currency ?? null]));
    let written = 0;
    const rejections: string[] = [];

    for (const [portfolioId, rows] of byPortfolio) {
      const ordered = [...rows].sort((a, b) =>
        a.snapshot_date < b.snapshot_date ? -1 : a.snapshot_date > b.snapshot_date ? 1 : 0,
      );
      const res = await writeEquitySnapshots(
        supabase as never,
        ordered.map((r, i) => ({
          portfolioId,
          snapshotDate: r.snapshot_date,
          cash: Number(r.cash),
          holdingsValue: Number(r.holdings_value),
          totalValue: Number(r.total_value),
          currency: currencyById.get(portfolioId) ?? null,
          source: "backfill" as const,
          ...(i > 0 ? { priorTotal: Number(ordered[i - 1]!.total_value) } : {}),
        })),
      );
      written += res.written;
      for (const r of res.rejected) {
        rejections.push(`${r.portfolioId}@${r.snapshotDate}: ${r.message ?? r.reason}`);
      }
    }

    if (rejections.length) {
      return { planned, written, error: `valuation gate rejected ${rejections.length} row(s): ${rejections[0]}` };
    }
    return { planned, written };
  } catch (err) {
    // Backfill must never break the read path — degrade to whatever exists.
    return { planned: [], written: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
