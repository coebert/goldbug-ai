// Server side of the "backtest vs real P&L" dashboard card.
//
// Loads the chosen (or most recent) saved backtest run for a portfolio, the
// portfolio's real equity snapshots flow-netted against recorded/detected
// deposits and withdrawals, and the realised broker fees on live fills, then
// hands them to the pure comparison in `backtest-vs-real.ts`.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  compareBacktestToReal,
  EMPTY_COMPARISON,
  type BacktestVsReal,
  type CurvePoint,
} from "@/lib/backtest-vs-real";
import {
  detectExternalFlows,
  flowAdjustedSeries,
  mergeFlows,
  type ExternalFlow,
} from "@/lib/equity-external-flows";

export type BacktestVsRealResult = BacktestVsReal & {
  runId: string | null;
  runRanAt: string | null;
  runRiskLevel: string | null;
  runDays: number | null;
  /** Every saved run, newest first, so the card can offer a picker. */
  availableRuns: Array<{
    id: string;
    ran_at: string;
    risk_level: string | null;
    days: number;
  }>;
  /** Actual trades the chosen run's engine dealt, when the run stored them. */
  runTrades: Array<{
    trade_date: string;
    side: "buy" | "sell";
    symbol: string;
    quantity: number;
    price: number;
    value: number;
  }>;
  /** Set when there is a run but no usable equity curve stored on it. */
  note: string | null;
};

function tradesFromStored(raw: unknown): BacktestVsRealResult["runTrades"] {
  const log = (raw as { trade_log?: unknown } | null)?.trade_log;
  if (!Array.isArray(log)) return [];
  return log
    .map((t) => {
      const r = t as Record<string, unknown>;
      const quantity = Number(r["quantity"] ?? 0);
      const price = Number(r["price"] ?? 0);
      return {
        trade_date: String(r["trade_date"] ?? ""),
        side: (r["side"] === "sell" ? "sell" : "buy") as "buy" | "sell",
        symbol: String(r["symbol"] ?? ""),
        quantity,
        price,
        value: Number.isFinite(Number(r["value"])) ? Number(r["value"]) : quantity * price,
      };
    })
    .filter((t) => t.symbol && t.trade_date);
}

type StoredEquityPoint = { snapshot_date?: string; date?: string; total_value?: number; value?: number };

function curveFromStored(raw: unknown): CurvePoint[] {
  if (!Array.isArray(raw)) return [];
  const out: CurvePoint[] = [];
  for (const r of raw as StoredEquityPoint[]) {
    const date = r?.snapshot_date ?? r?.date;
    const value = Number(r?.total_value ?? r?.value);
    if (typeof date === "string" && date && Number.isFinite(value)) {
      out.push({ date, value });
    }
  }
  return out;
}

export const getBacktestVsReal = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { portfolioId: string; runId?: string | null }) => input)
  .handler(async ({ data, context }): Promise<BacktestVsRealResult> => {
    const supabase = context.supabase;

    const { data: runs, error: runErr } = await supabase
      .from("backtest_runs")
      .select("id, ran_at, risk_level, days, equity, metrics")
      .eq("portfolio_id", data.portfolioId)
      .order("ran_at", { ascending: false })
      .limit(25);
    if (runErr) throw new Error(runErr.message);

    const available = (runs ?? []).map((r) => ({
      id: r.id as string,
      ran_at: r.ran_at as string,
      risk_level: (r.risk_level as string | null) ?? null,
      days: Number(r.days ?? 0),
    }));

    const chosen =
      (data.runId ? (runs ?? []).find((r) => r.id === data.runId) : null) ??
      (runs ?? []).find((r) => curveFromStored(r.equity).length >= 2) ??
      (runs ?? [])[0] ??
      null;

    const base = {
      runId: (chosen?.id as string | undefined) ?? null,
      runRanAt: (chosen?.ran_at as string | undefined) ?? null,
      runRiskLevel: (chosen?.risk_level as string | null | undefined) ?? null,
      runDays: chosen ? Number(chosen.days ?? 0) : null,
      availableRuns: available,
      runTrades: tradesFromStored(chosen?.metrics ?? null),
    };

    if (!chosen) {
      return {
        ...EMPTY_COMPARISON,
        ...base,
        note: "No saved backtest run yet — run a backtest and it will appear here.",
      };
    }

    const backtestCurve = curveFromStored(chosen.equity);
    if (backtestCurve.length < 2) {
      return {
        ...EMPTY_COMPARISON,
        ...base,
        note: "That run was saved without an equity curve, so there is nothing to line up against live P&L.",
      };
    }

    const [{ data: snaps, error: snapErr }, { data: funds }, { data: fills }, { data: orders }] =
      await Promise.all([

      supabase
        .from("equity_snapshots")
        .select("snapshot_date, total_value, cash, holdings_value")
        .eq("portfolio_id", data.portfolioId)
        .order("snapshot_date", { ascending: true }),
      supabase
        .from("sim_fund_events")
        .select("created_at, amount")
        .eq("portfolio_id", data.portfolioId),
      supabase
        .from("live_fills")
        .select(
          "order_id, symbol, side, quantity, fill_price, filled_at, created_at, fee, fee_commission, fee_exchange, fee_tax, fee_other, fee_source",
        )
        .eq("portfolio_id", data.portfolioId),
      supabase
        .from("live_orders")
        .select("id, limit_price")
        .eq("portfolio_id", data.portfolioId),

    ]);
    if (snapErr) throw new Error(snapErr.message);

    const points = (snaps ?? []).map((r) => ({
      date: String(r.snapshot_date),
      totalValue: Number(r.total_value ?? 0),
      cash: Number(r.cash ?? 0),
      holdingsValue: Number(r.holdings_value ?? 0),
    }));

    const recorded: ExternalFlow[] = (funds ?? []).map((f) => ({
      date: String(f.created_at ?? "").slice(0, 10),
      amount: Number(f.amount ?? 0),
      source: "recorded" as const,
    }));
    const flows = mergeFlows(recorded, detectExternalFlows(points));
    // flowAdjustedSeries restates history onto today's capital base, so every
    // point in the real curve is measured on the same money.
    const realCurve: CurvePoint[] = flowAdjustedSeries(points, flows).map((r) => ({
      date: r.date,
      value: r.adjusted,
    }));

    // Intended price per order, so an adverse fill can be priced as slippage.
    const intended = new Map<string, number>();
    for (const o of orders ?? []) {
      const want = Number(o.limit_price ?? 0);
      if (Number.isFinite(want) && want > 0) intended.set(String(o.id), want);
    }

    const fees = (fills ?? []).map((f) => {
      const commission = Number(f.fee_commission ?? 0);
      const tax = Number(f.fee_tax ?? 0);
      const exchange = Number(f.fee_exchange ?? 0);
      const other = Number(f.fee_other ?? 0);
      const itemised = commission + tax + exchange + other;
      // `fee` is the broker's headline charge; when the itemised columns are
      // richer (stamp duty synced separately) take whichever is larger so tax
      // is never dropped from the total.
      const amount = Math.max(Math.abs(Number(f.fee ?? 0)), Math.abs(itemised));

      const want = intended.get(String(f.order_id ?? ""));
      const got = Number(f.fill_price ?? 0);
      const qty = Math.abs(Number(f.quantity ?? 0));
      let slippage = 0;
      if (want && Number.isFinite(got) && got > 0 && qty > 0) {
        const adverse = String(f.side) === "sell" ? want - got : got - want;
        if (adverse > 0) slippage = adverse * qty;
      }

      return {
        date: String(f.filled_at ?? f.created_at ?? "").slice(0, 10),
        amount,
        commission,
        tax,
        exchange,
        other,
        slippage,
        invoiced: Boolean(f.fee_source && f.fee_source !== "none" && f.fee_source !== "modelled"),
      };
    });


    const comparison = compareBacktestToReal({
      backtest: backtestCurve,
      real: realCurve,
      fees,
    });

    return {
      ...comparison,
      ...base,
      note:
        comparison.days < 2
          ? "The saved run and your live history don't overlap on any two days yet."
          : null,
    };
  });
