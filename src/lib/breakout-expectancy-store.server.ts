// Live accessor for the breakout expectancy table.
//
// The trading engine must never block on a database round-trip per order, and
// must never run on an unvetted table. So this module:
//   * reads the newest PUBLISHED row from `breakout_expectancy_runs`,
//   * caches it in-process for a few minutes,
//   * falls back to the recorded Aug-2026 study when nothing is published yet
//     or the read fails, so the gate degrades to its previous behaviour rather
//     than to "no opinion".

import {
  DEFAULT_BREAKOUT_EXPECTANCY,
  type BreakoutExpectancyTable,
} from "@/lib/alpha/breakout-regime-policy";
import { parseExpectancyTable } from "@/lib/breakout-expectancy-refresh";

const CACHE_TTL_MS = 5 * 60_000;

let cached: { table: BreakoutExpectancyTable; at: number } | null = null;

/** Drop the memo so the next read picks up a freshly published table. */
export function invalidateLiveExpectancyCache(): void {
  cached = null;
}

/**
 * The expectancy table the live regime gate should use right now.
 * Never throws: a failed read degrades to the last known-good default.
 */
export async function loadLiveExpectancyTable(): Promise<BreakoutExpectancyTable> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.table;

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("breakout_expectancy_runs")
      .select("source, as_of, cells")
      .eq("status", "published")
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const parsed = data
      ? parseExpectancyTable({ source: data.source, asOf: data.as_of, cells: data.cells })
      : null;
    const table = parsed ?? DEFAULT_BREAKOUT_EXPECTANCY;
    cached = { table, at: now };
    return table;
  } catch (e) {
    console.warn("breakout expectancy: falling back to recorded study", e);
    cached = { table: DEFAULT_BREAKOUT_EXPECTANCY, at: now };
    return DEFAULT_BREAKOUT_EXPECTANCY;
  }
}
