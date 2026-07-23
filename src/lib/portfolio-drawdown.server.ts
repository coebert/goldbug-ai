// Portfolio-level 5-day drawdown sizing + gross exposure cap.
// Both feed into the trading engine to shrink new buys when the portfolio
// itself is losing money or when the macro regime demands lower gross exposure.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { PersistedRegime } from "./regime-detector.server";

export type DrawdownSizing = {
  peak_5d: number | null;
  current: number | null;
  drawdown_pct: number; // 0..1
  size_multiplier: number; // <=1
  note: string;
};

/**
 * Look at the last 6 equity snapshots. If the current total_value is materially
 * below the 5-day rolling peak, shrink new buy sizes proportionally.
 * Rule of thumb:
 *   dd <= 2%  → 1.00
 *   dd <= 4%  → 0.75
 *   dd <= 7%  → 0.50
 *   dd  > 7%  → 0.30
 */
export async function computePortfolioDrawdownSizing(
  portfolioId: string,
): Promise<DrawdownSizing> {
  const { data } = await supabaseAdmin
    .from("equity_snapshots")
    .select("total_value, snapshot_date")
    .eq("portfolio_id", portfolioId)
    .order("snapshot_date", { ascending: false })
    .limit(6);
  const rows = data ?? [];
  if (rows.length < 2) {
    return { peak_5d: null, current: null, drawdown_pct: 0, size_multiplier: 1, note: "insufficient history" };
  }
  const current = Number(rows[0].total_value);
  const peak = Math.max(...rows.map((r) => Number(r.total_value)));
  const dd = peak > 0 ? Math.max(0, (peak - current) / peak) : 0;
  let mult = 1;
  let note = "portfolio drawdown within normal bounds";
  if (dd > 0.07) {
    mult = 0.3;
    note = `portfolio drawdown ${(dd * 100).toFixed(1)}% (>7%) — new buys ×0.30`;
  } else if (dd > 0.04) {
    mult = 0.5;
    note = `portfolio drawdown ${(dd * 100).toFixed(1)}% (>4%) — new buys ×0.50`;
  } else if (dd > 0.02) {
    mult = 0.75;
    note = `portfolio drawdown ${(dd * 100).toFixed(1)}% (>2%) — new buys ×0.75`;
  }
  return { peak_5d: peak, current, drawdown_pct: dd, size_multiplier: mult, note };
}

/**
 * Gross exposure = holdings_value / total_value. When regime is crisis or bear,
 * limit gross exposure to ~40% and ~60% respectively; return how much extra
 * spend is allowed and a suggested target so trim logic can also use it.
 */
export function grossExposureLimit(
  totalValue: number,
  holdingsValue: number,
  regime: PersistedRegime,
): { current_pct: number; target_pct: number; room: number; note: string } {
  const cur = totalValue > 0 ? holdingsValue / totalValue : 0;
  let target = 1;
  if (regime.regime === "crisis") target = 0.4;
  else if (regime.regime === "bear") target = 0.6;
  else if (regime.regime === "correction") target = 0.8;
  const room = Math.max(0, totalValue * target - holdingsValue);
  const note = target < 1
    ? `gross exposure target ${(target * 100).toFixed(0)}% for ${regime.regime} regime (currently ${(cur * 100).toFixed(0)}%)`
    : "no regime gross-exposure cap";
  return { current_pct: cur, target_pct: target, room, note };
}
