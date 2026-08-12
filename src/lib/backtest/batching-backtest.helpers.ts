// Pure helpers for the order-batching A/B backtest server function.
//
// Kept out of `batching-backtest.functions.ts` because server-function modules
// are split at build time: only imports, types and the exported server-fn
// declarations survive in the client graph, so any runtime sibling declared
// there would vanish at runtime.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { BacktestBar } from "../backtest-runner";

/** Cap on how many names the replay covers — keeps the query and CPU bounded. */
export const MAX_REPLAY_SYMBOLS = 8;

/**
 * Per-bar add size as a fraction of NAV. Deliberately small: sub-minimum
 * drips are precisely the case batching claims to fix.
 */
export const DEFAULT_REPLAY_ADD_PCT = 0.009;

/**
 * Rank the portfolio's symbols by relevance: anything currently held first,
 * then the most frequently traded names.
 */
export function rankTradedSymbols(
  held: readonly string[],
  traded: readonly string[],
  limit = MAX_REPLAY_SYMBOLS,
): string[] {
  const counts = new Map<string, number>();
  for (const s of held) {
    if (s) counts.set(s, 1_000);
  }
  for (const s of traded) {
    if (!s) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] === a[1] ? (a[0] < b[0] ? -1 : 1) : b[1] - a[1]))
    .slice(0, Math.max(0, limit))
    .map(([s]) => s);
}

/** Collapse per-symbol price rows into chronological, multi-symbol bars. */
export function buildReplayBars(
  rows: ReadonlyArray<{ symbol: string; price_date: string; close: number }>,
): BacktestBar[] {
  const byDate = new Map<string, Record<string, number>>();
  for (const r of rows) {
    if (!Number.isFinite(r.close) || r.close <= 0) continue;
    const date = String(r.price_date).slice(0, 10);
    const row = byDate.get(date) ?? {};
    row[r.symbol] = r.close;
    byDate.set(date, row);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, closes]) => ({ date, closes }));
}

/**
 * Shared loader for the replay backtests: resolve the portfolio's traded
 * symbols, collapse cached closes into bars, and derive the NAV the replay
 * sizes against. The Supabase client is passed in so the caller's RLS applies.
 */
export async function loadReplayInputs(
  supabase: SupabaseClient<Database>,
  args: { portfolioId: string; days: number },
): Promise<{ bars: BacktestBar[]; symbols: string[]; navBase: number }> {
  const { data: pf } = await supabase
    .from("portfolios")
    .select("id, starting_cash, current_cash")
    .eq("id", args.portfolioId)
    .maybeSingle();
  if (!pf) throw new Error("Portfolio not found");

  const [{ data: holdRows }, { data: tradeRows }] = await Promise.all([
    supabase.from("holdings").select("symbol").eq("portfolio_id", args.portfolioId),
    supabase
      .from("trades")
      .select("symbol")
      .eq("portfolio_id", args.portfolioId)
      .order("trade_date", { ascending: false })
      .limit(400),
  ]);

  const symbols = rankTradedSymbols(
    (holdRows ?? []).map((r) => String(r.symbol)),
    (tradeRows ?? []).map((r) => String(r.symbol)),
    MAX_REPLAY_SYMBOLS,
  );
  if (symbols.length === 0) {
    throw new Error("No traded symbols yet — the replay needs some history to work with.");
  }

  const from = new Date(Date.now() - args.days * 86_400_000).toISOString().slice(0, 10);
  const { data: priceRows, error } = await supabase
    .from("price_cache")
    .select("symbol, price_date, close")
    .in("symbol", symbols)
    .gte("price_date", from)
    .order("price_date", { ascending: true });
  if (error) throw new Error(error.message);

  const bars = buildReplayBars(
    (priceRows ?? []).map((r) => ({
      symbol: String(r.symbol),
      price_date: String(r.price_date),
      close: Number(r.close),
    })),
  );
  if (bars.length < 60) {
    throw new Error(
      `Not enough price history to replay (${bars.length} bars, need 60+). Let the price cache fill in first.`,
    );
  }

  const navBase = Math.max(
    1_000,
    Number(pf.starting_cash ?? 0) || Number(pf.current_cash ?? 0) || 10_000,
  );

  return { bars, symbols, navBase };
}
