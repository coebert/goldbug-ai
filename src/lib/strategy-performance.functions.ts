// Server side of the strategy performance page.
//
// Reads the portfolio's daily equity snapshots, nets out deposits and
// withdrawals (recorded + detected) exactly like the backtest-vs-real card,
// then hands the clean curve to the pure metric module.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  computeStrategyPerformance,
  EMPTY_PERFORMANCE,
  type PerfPoint,
  type StrategyPerformance,
} from "@/lib/strategy-performance";
import {
  detectExternalFlows,
  flowAdjustedSeries,
  mergeFlows,
  type ExternalFlow,
} from "@/lib/equity-external-flows";

export type StrategyPerformanceResult = StrategyPerformance & {
  currency: string;
  /** Curve the metrics were computed from, for charting. */
  curve: PerfPoint[];
  /** Deposits/withdrawals netted out of the curve. */
  flowsNetted: number;
  flowCount: number;
  /** Realised broker fees inside the window, and as bps of start equity. */
  fees: number;
  feesBps: number;
  note: string | null;
};

export const getStrategyPerformance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { portfolioId: string }) => input)
  .handler(async ({ data, context }): Promise<StrategyPerformanceResult> => {
    const supabase = context.supabase;

    const [{ data: p }, { data: snaps, error: snapErr }, { data: funds }, { data: fills }] =
      await Promise.all([
        supabase.from("portfolios").select("currency").eq("id", data.portfolioId).maybeSingle(),
        supabase
          .from("equity_snapshots")
          .select("snapshot_date, total_value, cash, holdings_value")
          .eq("portfolio_id", data.portfolioId)
          .order("snapshot_date", { ascending: true }),
        supabase.from("sim_fund_events").select("created_at, amount").eq("portfolio_id", data.portfolioId),
        supabase.from("live_fills").select("filled_at, created_at, fee").eq("portfolio_id", data.portfolioId),
      ]);
    if (snapErr) throw new Error(snapErr.message);

    const currency = String(p?.currency ?? "GBP").toUpperCase();

    const points = (snaps ?? []).map((r) => ({
      date: String(r.snapshot_date),
      totalValue: Number(r.total_value ?? 0),
      cash: Number(r.cash ?? 0),
      holdingsValue: Number(r.holdings_value ?? 0),
    }));

    if (points.length < 2) {
      return {
        ...EMPTY_PERFORMANCE,
        currency,
        curve: [],
        flowsNetted: 0,
        flowCount: 0,
        fees: 0,
        feesBps: 0,
        note: "Not enough daily equity history yet — performance needs at least two days.",
      };
    }

    const recorded: ExternalFlow[] = (funds ?? []).map((f) => ({
      date: String(f.created_at ?? "").slice(0, 10),
      amount: Number(f.amount ?? 0),
      source: "recorded" as const,
    }));
    const flows = mergeFlows(recorded, detectExternalFlows(points));
    const curve: PerfPoint[] = flowAdjustedSeries(points, flows).map((r) => ({
      date: r.date,
      value: r.adjusted,
    }));

    const perf = computeStrategyPerformance(curve);

    const from = perf.from ?? "";
    const to = perf.to ?? "";
    const fees = (fills ?? [])
      .map((f) => ({
        date: String(f.filled_at ?? f.created_at ?? "").slice(0, 10),
        amount: Number(f.fee ?? 0),
      }))
      .filter((f) => Number.isFinite(f.amount) && f.date >= from && f.date <= to)
      .reduce((s, f) => s + f.amount, 0);

    return {
      ...perf,
      currency,
      curve,
      flowsNetted: flows.reduce((s, f) => s + f.amount, 0),
      flowCount: flows.length,
      fees,
      feesBps: perf.startEquity > 0 ? (fees / perf.startEquity) * 10_000 : 0,
      note:
        perf.annualisedReturnPct == null
          ? "The window is still shorter than a month, so the return is shown as-is rather than annualised (annualising a few days invents a number)."
          : null,
    };
  });
