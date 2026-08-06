// Server driver for the fill-unit backfill.
//
// Loads every stored fill for the caller's portfolios, plans the corrections
// with the pure planner, writes them, and then recomputes the figures that
// were built on the wrong numbers: the trades ledger (rebuilt from fills for
// live portfolios) and the historical equity snapshots.
//
// Runs `dryRun` by default at the call site so the plan can be read before
// anything is rewritten.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { symbolKeys } from "./equity-snapshot-revalue";
import {
  planFillUnitBackfill,
  type BackfillFill,
  type CloseSeries,
  type FillUnitBackfillPlan,
  type FillUnitDecision,
} from "./fill-unit-backfill";

const PAGE = 1000;

export type FillUnitBackfillResult = {
  dryRun: boolean;
  fillsScanned: number;
  counts: FillUnitBackfillPlan["counts"];
  /** Every row the plan would rewrite, capped for transport. */
  changes: FillUnitDecision[];
  updated: number;
  updateErrors: Array<{ id: string; message: string }>;
  recompute: Array<{
    portfolioId: string;
    tradesRebuilt: number | null;
    snapshotsRewritten: number | null;
    error?: string;
  }>;
  generatedAt: string;
};

const MAX_REPORTED_CHANGES = 500;

async function loadCloses(
  admin: SupabaseClient<Database>,
  symbols: string[],
  since: string,
): Promise<CloseSeries> {
  const out: CloseSeries = new Map();
  const wanted = new Set(symbols.flatMap((s) => symbolKeys(s)));
  if (wanted.size === 0) return out;

  for (let from = 0; ; from += PAGE) {
    const page = await admin
      .from("price_cache")
      .select("symbol, price_date, close")
      .gte("price_date", since)
      .order("price_date", { ascending: true })
      .range(from, from + PAGE - 1);
    if (page.error) throw new Error(`load price_cache failed: ${page.error.message}`);
    const rows = page.data ?? [];
    for (const row of rows) {
      const symbol = String(row.symbol ?? "").toUpperCase();
      if (!wanted.has(symbol)) continue;
      const close = Number(row.close);
      if (!Number.isFinite(close) || close <= 0) continue;
      out.set(symbol, [
        ...(out.get(symbol) ?? []),
        { date: String(row.price_date).slice(0, 10), close },
      ]);
    }
    if (rows.length < PAGE) break;
  }

  // A fill's symbol may be stored under any of its spellings (`MKS:xlon`,
  // `MKS.L`); alias every key of a series so lookups hit whichever is used.
  for (const [key, series] of [...out.entries()]) {
    for (const alias of symbolKeys(key)) {
      if (!out.has(alias)) out.set(alias, series);
    }
  }
  return out;
}

export async function runFillUnitBackfill(params: {
  db: SupabaseClient<Database>;
  userId: string;
  portfolioId?: string;
  dryRun?: boolean;
}): Promise<FillUnitBackfillResult> {
  const dryRun = params.dryRun !== false;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Ownership is established through the caller's RLS-scoped client; the
  // admin client is used only for the rewrite itself.
  let pfq = params.db.from("portfolios").select("id, currency, mode").eq("user_id", params.userId);
  if (params.portfolioId) pfq = pfq.eq("id", params.portfolioId);
  const pf = await pfq;
  if (pf.error) throw new Error(pf.error.message);
  const portfolios = pf.data ?? [];
  const ids = portfolios.map((p) => p.id as string);

  const empty: FillUnitBackfillResult = {
    dryRun,
    fillsScanned: 0,
    counts: { ok: 0, fold_gbx: 0, unfold_gbx: 0, unexplained: 0, no_reference: 0 },
    changes: [],
    updated: 0,
    updateErrors: [],
    recompute: [],
    generatedAt: new Date().toISOString(),
  };
  if (ids.length === 0) return empty;

  const fills: BackfillFill[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await supabaseAdmin
      .from("live_fills")
      .select("id, portfolio_id, symbol, side, quantity, fill_price, currency, filled_at")
      .in("portfolio_id", ids)
      .order("filled_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (page.error) throw new Error(`load live_fills failed: ${page.error.message}`);
    const rows = page.data ?? [];
    for (const r of rows) {
      fills.push({
        id: r.id as string,
        portfolio_id: r.portfolio_id as string,
        symbol: String(r.symbol),
        side: (r.side as string | null) ?? null,
        quantity: r.quantity as number | string | null,
        fill_price: r.fill_price as number | string | null,
        currency: (r.currency as string | null) ?? null,
        filled_at: (r.filled_at as string | null) ?? null,
      });
    }
    if (rows.length < PAGE) break;
  }
  if (fills.length === 0) return empty;

  const firstDay = (fills[0]?.filled_at ?? "").slice(0, 10) || "1970-01-01";
  const since = new Date(new Date(`${firstDay}T00:00:00Z`).getTime() - 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const closes = await loadCloses(
    supabaseAdmin as unknown as SupabaseClient<Database>,
    [...new Set(fills.map((f) => f.symbol))],
    since,
  );

  const plan = planFillUnitBackfill({
    fills,
    closes,
    portfolioCurrency: new Map(
      portfolios.map((p) => [p.id as string, String(p.currency ?? "GBP").toUpperCase()]),
    ),
  });

  const result: FillUnitBackfillResult = {
    ...empty,
    fillsScanned: fills.length,
    counts: plan.counts,
    changes: plan.changes.slice(0, MAX_REPORTED_CHANGES),
  };
  if (dryRun || plan.changes.length === 0) return result;

  for (const change of plan.changes) {
    const upd = await supabaseAdmin
      .from("live_fills")
      .update({ fill_price: change.correctedPrice, currency: change.correctedCurrency })
      .eq("id", change.id);
    if (upd.error) result.updateErrors.push({ id: change.id, message: upd.error.message });
    else result.updated += 1;
  }

  // Recompute everything derived from the corrected history. Both steps are
  // idempotent, so a partially-applied rewrite can simply be re-run.
  const modeById = new Map(portfolios.map((p) => [p.id as string, String(p.mode ?? "")]));
  for (const portfolioId of plan.affectedPortfolioIds) {
    const entry: FillUnitBackfillResult["recompute"][number] = {
      portfolioId,
      tradesRebuilt: null,
      snapshotsRewritten: null,
    };
    try {
      const mode = modeById.get(portfolioId) ?? "";
      if (mode === "live_sim" || mode === "live_prod") {
        const { reconcileFillsToTradesForPortfolio } = await import(
          "./fills-trades-reconcile.server"
        );
        const rebuilt = await reconcileFillsToTradesForPortfolio(portfolioId, params.userId);
        entry.tradesRebuilt = (rebuilt as { tradesInserted?: number }).tradesInserted ?? null;
      }
      const { revalueHistoricalSnapshots } = await import("./equity-snapshot-revalue.server");
      const revalued = await revalueHistoricalSnapshots(supabaseAdmin, portfolioId, {});
      entry.snapshotsRewritten = revalued.written;
    } catch (e) {
      entry.error = e instanceof Error ? e.message : String(e);
    }
    result.recompute.push(entry);
  }

  return result;
}
