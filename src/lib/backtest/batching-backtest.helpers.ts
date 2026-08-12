// Pure helpers for the order-batching A/B backtest server function.
//
// Kept out of `batching-backtest.functions.ts` because server-function modules
// are split at build time: only imports, types and the exported server-fn
// declarations survive in the client graph, so any runtime sibling declared
// there would vanish at runtime.

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
