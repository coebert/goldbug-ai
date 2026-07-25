// Hard portfolio-level risk halts.
//
// Three cutoffs, each independent:
//
//   1. max_position_pct — the largest slice of the pot any one asset can
//      hold. Already enforced elsewhere in the trading engine when sizing
//      individual buys; surfaced here so callers can display the current
//      binding cap.
//   2. max_daily_loss_pct — if today's mark-to-market loss vs the last
//      snapshot exceeds this, block ALL new buys for the day. Sells
//      (including auto-stop-losses) still fire so the portfolio can de-risk.
//   3. max_drawdown_halt_pct — if the peak-to-current drawdown across
//      the portfolio's whole history exceeds this, block ALL new buys
//      until equity recovers back inside the threshold.
//
// Pure evaluator + a tiny DB helper for the peak / prior close. No I/O in
// the evaluator so it stays trivially testable.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type HaltThresholds = {
  max_position_pct: number;      // 0..1 (informational at this layer)
  max_daily_loss_pct: number;    // 0..1, 0 disables
  max_drawdown_halt_pct: number; // 0..1, 0 disables
};

export type HaltInputs = {
  startingEquity: number;   // portfolio.starting_cash — anchor for absolute pct
  currentEquity: number;    // pre-decision cash + holdings mark-to-market
  priorCloseEquity: number | null; // yesterday's snapshot (null if none yet)
  peakEquity: number | null;       // all-time peak snapshot (null if none)
  thresholds: HaltThresholds;
};

export type HaltStatus = {
  daily_loss_pct: number;        // signed: negative = loss
  drawdown_pct: number;          // 0..1, always non-negative
  daily_loss_halt: boolean;
  drawdown_halt: boolean;
  any_halt: boolean;
  reason: string | null;         // human-readable summary when halted
  thresholds: HaltThresholds;
  inputs: {
    starting_equity: number;
    current_equity: number;
    prior_close_equity: number | null;
    peak_equity: number | null;
  };
};

export function evaluateRiskHalts(i: HaltInputs): HaltStatus {
  const dailyDenominator = i.priorCloseEquity && i.priorCloseEquity > 0
    ? i.priorCloseEquity
    : i.startingEquity;
  const dailyLossPct = dailyDenominator > 0
    ? (i.currentEquity - dailyDenominator) / dailyDenominator
    : 0;

  const peakBasis = Math.max(i.peakEquity ?? 0, i.startingEquity, i.currentEquity);
  const drawdownPct = peakBasis > 0
    ? Math.max(0, (peakBasis - i.currentEquity) / peakBasis)
    : 0;

  const dailyHalt =
    i.thresholds.max_daily_loss_pct > 0 &&
    dailyLossPct <= -i.thresholds.max_daily_loss_pct;
  const drawHalt =
    i.thresholds.max_drawdown_halt_pct > 0 &&
    drawdownPct >= i.thresholds.max_drawdown_halt_pct;

  const reasons: string[] = [];
  if (dailyHalt) {
    reasons.push(
      `daily loss ${(dailyLossPct * 100).toFixed(2)}% breached −${(i.thresholds.max_daily_loss_pct * 100).toFixed(1)}%`,
    );
  }
  if (drawHalt) {
    reasons.push(
      `drawdown ${(drawdownPct * 100).toFixed(2)}% breached ${(i.thresholds.max_drawdown_halt_pct * 100).toFixed(1)}%`,
    );
  }
  return {
    daily_loss_pct: dailyLossPct,
    drawdown_pct: drawdownPct,
    daily_loss_halt: dailyHalt,
    drawdown_halt: drawHalt,
    any_halt: dailyHalt || drawHalt,
    reason: reasons.length ? reasons.join("; ") : null,
    thresholds: i.thresholds,
    inputs: {
      starting_equity: i.startingEquity,
      current_equity: i.currentEquity,
      prior_close_equity: i.priorCloseEquity,
      peak_equity: i.peakEquity,
    },
  };
}

/**
 * Reads all equity snapshots for the portfolio to derive:
 *   • prior-close equity (the snapshot strictly before `asOf`), and
 *   • all-time peak equity.
 *
 * `client` can be an authenticated per-user client (RLS) or the admin
 * client — the caller decides which is appropriate for the surface.
 */
export async function loadEquityStats(
  client: SupabaseClient<Database>,
  portfolioId: string,
  asOf: string,
): Promise<{ priorCloseEquity: number | null; peakEquity: number | null }> {
  const { data } = await client
    .from("equity_snapshots")
    .select("total_value, snapshot_date")
    .eq("portfolio_id", portfolioId)
    .order("snapshot_date", { ascending: false })
    .limit(400);
  const rows = data ?? [];
  if (rows.length === 0) return { priorCloseEquity: null, peakEquity: null };
  const peak = rows.reduce((m, r) => Math.max(m, Number(r.total_value) || 0), 0);
  const prior = rows.find((r) => (r.snapshot_date as string) < asOf);
  return {
    peakEquity: peak > 0 ? peak : null,
    priorCloseEquity: prior ? Number(prior.total_value) : null,
  };
}
