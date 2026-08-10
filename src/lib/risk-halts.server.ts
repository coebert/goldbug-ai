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
  /**
   * Portion of `currentEquity` that was valued off cost basis because no live
   * quote resolved. When this is a material share of the book the NAV is not
   * trustworthy and must not be allowed to fabricate a drawdown halt.
   */
  unpricedHoldingsValue?: number;
  /** Independent NAV from the broker. Preferred over the derived valuation. */
  brokerEquity?: number | null;
};

export type HaltStatus = {
  daily_loss_pct: number;        // signed: negative = loss
  drawdown_pct: number;          // 0..1, always non-negative
  daily_loss_halt: boolean;
  drawdown_halt: boolean;
  any_halt: boolean;
  reason: string | null;         // human-readable summary when halted
  /** True when halts were suppressed because the valuation looked unreliable. */
  valuation_suspect: boolean;
  valuation_source: "derived" | "broker";
  thresholds: HaltThresholds;
  inputs: {
    starting_equity: number;
    current_equity: number;
    prior_close_equity: number | null;
    peak_equity: number | null;
    unpriced_holdings_value: number;
    broker_equity: number | null;
  };
};

/** Share of NAV that may be cost-basis-valued before we distrust the NAV. */
const MAX_UNPRICED_SHARE = 0.1;
/** A single-step collapse this deep vs prior close is a data fault, not a market move. */
const IMPLAUSIBLE_COLLAPSE = 0.5;

export function evaluateRiskHalts(i: HaltInputs): HaltStatus {
  const brokerEquity =
    i.brokerEquity != null && Number.isFinite(i.brokerEquity) && i.brokerEquity > 0
      ? i.brokerEquity
      : null;
  // The broker's own NAV is authoritative when we have it: the derived
  // valuation can miss quotes, while the broker prices the whole book.
  const currentEquity = brokerEquity ?? i.currentEquity;
  const valuationSource: "derived" | "broker" = brokerEquity != null ? "broker" : "derived";

  const unpriced = Math.max(0, i.unpricedHoldingsValue ?? 0);

  const dailyDenominator = i.priorCloseEquity && i.priorCloseEquity > 0
    ? i.priorCloseEquity
    : i.startingEquity;
  const dailyLossPct = dailyDenominator > 0
    ? (currentEquity - dailyDenominator) / dailyDenominator
    : 0;

  const peakBasis = Math.max(i.peakEquity ?? 0, i.startingEquity, currentEquity);
  const drawdownPct = peakBasis > 0
    ? Math.max(0, (peakBasis - currentEquity) / peakBasis)
    : 0;

  // Two independent signals that the NAV we just computed is not real:
  //   • a material slice of the book had no quote (cost-basis fallback), or
  //   • equity supposedly halved (or worse) in one step versus prior close.
  // Either one previously produced a phantom "drawdown breached" halt that
  // blocked every buy for the rest of the day.
  const unpricedShare = currentEquity > 0 ? unpriced / currentEquity : 0;
  const collapsedVsPrior =
    i.priorCloseEquity != null &&
    i.priorCloseEquity > 0 &&
    currentEquity < i.priorCloseEquity * (1 - IMPLAUSIBLE_COLLAPSE);
  const valuationSuspect =
    valuationSource === "derived" && (unpricedShare > MAX_UNPRICED_SHARE || collapsedVsPrior);

  const dailyHalt =
    !valuationSuspect &&
    i.thresholds.max_daily_loss_pct > 0 &&
    dailyLossPct <= -i.thresholds.max_daily_loss_pct;
  const drawHalt =
    !valuationSuspect &&
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
    valuation_suspect: valuationSuspect,
    valuation_source: valuationSource,
    thresholds: i.thresholds,
    inputs: {
      starting_equity: i.startingEquity,
      current_equity: currentEquity,
      prior_close_equity: i.priorCloseEquity,
      peak_equity: i.peakEquity,
      unpriced_holdings_value: unpriced,
      broker_equity: brokerEquity,
    },
  };
}


/**
 * Reads all equity snapshots for the portfolio to derive:
 *   • prior-close equity (the snapshot strictly before `asOf`), and
 *   • all-time peak equity.
 *
 * Both are restated onto today's capital base by netting out external cash
 * flows (recorded sim deposits plus detected deposit/withdrawal steps). A
 * deposit that later leaves the account must never read as a trading
 * drawdown — that previously halted every BUY on the portfolio indefinitely.
 *
 * `client` can be an authenticated per-user client (RLS) or the admin
 * client — the caller decides which is appropriate for the surface.
 */
export async function loadEquityStats(
  client: SupabaseClient<Database>,
  portfolioId: string,
  asOf: string,
): Promise<{ priorCloseEquity: number | null; peakEquity: number | null; netExternalFlow: number }> {
  const { data } = await client
    .from("equity_snapshots")
    .select("total_value, cash, holdings_value, snapshot_date")
    .eq("portfolio_id", portfolioId)
    .order("snapshot_date", { ascending: false })
    .limit(400);
  const rows = data ?? [];
  if (rows.length === 0) {
    return { priorCloseEquity: null, peakEquity: null, netExternalFlow: 0 };
  }

  const points = rows.map((r) => ({
    date: String(r.snapshot_date),
    totalValue: Number(r.total_value) || 0,
    cash: Number(r.cash) || 0,
    holdingsValue: Number(r.holdings_value) || 0,
  }));

  const { detectExternalFlows, mergeFlows, flowAdjustedStats } = await import(
    "./equity-external-flows"
  );

  // Recorded sim funding events are authoritative where they exist.
  const recorded: Array<{ date: string; amount: number; source: "recorded" }> = [];
  const funds = await client
    .from("sim_fund_events")
    .select("amount, created_at")
    .eq("portfolio_id", portfolioId)
    .order("created_at", { ascending: true })
    .limit(400);
  for (const f of funds.data ?? []) {
    const amount = Number(f.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    recorded.push({ date: String(f.created_at).slice(0, 10), amount, source: "recorded" });
  }

  const flows = mergeFlows(recorded, detectExternalFlows(points));
  const stats = flowAdjustedStats(points, flows, asOf);
  return {
    peakEquity: stats.peakEquity,
    priorCloseEquity: stats.priorCloseEquity,
    netExternalFlow: stats.netFlow,
  };
}

