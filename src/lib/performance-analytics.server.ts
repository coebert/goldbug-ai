// Performance analytics dashboard — server-side compute.
//
// Combines three signals stored per user:
//   • equity_snapshots  → equity curve + drawdown curve
//   • trades            → FIFO round-trip realized PnL (per closed lot)
//   • decisions.raw     → regime tag + sizing/exit/execution phase metadata
//
// Each realized round-trip is attributed to:
//   • Regime  — from decisions.raw.regime.regime on the BUY day (state at entry)
//   • Sizing  — conviction_bonus | risk_parity | baseline (from BUY executed row)
//   • Exit    — chandelier | scale_out | time_stop | stop_loss | event_exit |
//               rebalance_trim | ai_sell | trail | other (from SELL trades.reason)
//   • Execution — tod_blocked | tod_haircut | sliced | normal
//                 (union of BUY + SELL exec-alpha telemetry from decisions.raw)
//
// Returned as SSR-serializable DTOs (arrays of plain objects). No streams,
// SDK clients, or class instances.

import type { OwnedDbClient } from "@/lib/_server/owned-client";
import { computeMaxDrawdown, type EquityPoint, type TradeRow } from "@/lib/backtest-metrics";

export type EquityCurvePoint = { date: string; equity: number };
export type DrawdownPoint = { date: string; drawdownPct: number; equity: number; peak: number };

export type AttributionSlice = {
  key: string;
  label: string;
  realizedPnl: number;
  trips: number;
  winRatePct: number | null;
  avgPnl: number | null;
};

export type PerformanceAnalytics = {
  windowDays: number;
  currency: string;
  startingEquity: number | null;
  endingEquity: number | null;
  totalReturnPct: number | null;
  maxDrawdownPct: number;
  maxDrawdownPeakDate: string | null;
  maxDrawdownTroughDate: string | null;
  totalRealizedPnl: number;
  roundTrips: number;
  equityCurve: EquityCurvePoint[];
  drawdownCurve: DrawdownPoint[];
  /** Executed trades in the window, for chart markers. */
  trades: Array<{
    symbol: string;
    side: "buy" | "sell";
    quantity: number;
    price: number;
    trade_date: string;
    executed_at: string | null;
  }>;
  regimeAttribution: AttributionSlice[];
  sizingAttribution: AttributionSlice[];
  exitAttribution: AttributionSlice[];
  executionAttribution: AttributionSlice[];
};

type DecisionExecutedRow = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  reason?: string;
  rejected?: string;
  tod?: { multiplier: number; allow: boolean; reason: string };
  slice_plan?: { childCount: number; childNotional: number; advParticipationPct: number | null; reason: string };
};

type DecisionRaw = {
  regime?: { regime?: string } | null;
  executed?: DecisionExecutedRow[];
};

type BuyLot = {
  qty: number;
  price: number;
  date: string;
  regime: string;
  sizing: PhaseKey;
  execution: PhaseKey;
};

type PhaseKey = string;

function classifySizing(reason: string): PhaseKey {
  const r = reason.toLowerCase();
  if (/(conviction[_ ]?bonus|alpha[_ ]?bonus)/.test(r)) return "conviction_bonus";
  if (/(risk[_ ]?parity|vol[_ ]?sized|vol[_ ]?target)/.test(r)) return "risk_parity";
  return "baseline";
}

function classifyExit(reason: string): PhaseKey {
  const r = reason.toLowerCase();
  if (/chandelier/.test(r)) return "chandelier";
  if (/(scale[_ ]?out|take[_ ]?profit|\btp\b)/.test(r)) return "scale_out";
  if (/(time[_ ]?stop|max[_ ]?hold|max-hold)/.test(r)) return "time_stop";
  if (/stop[_ -]?loss|atr[_ ]?stop/.test(r)) return "stop_loss";
  if (/trail/.test(r)) return "trail";
  if (/(event|blackout)/.test(r)) return "event_exit";
  if (/rebalance/.test(r)) return "rebalance_trim";
  if (/ai[_ ]?sell|discretionary/.test(r)) return "ai_sell";
  return "other";
}

function classifyExecution(row: DecisionExecutedRow | undefined): PhaseKey {
  if (!row) return "normal";
  if (row.rejected && /tod\s*block/i.test(row.rejected)) return "tod_blocked";
  if (row.tod && row.tod.multiplier < 1) return "tod_haircut";
  if (row.slice_plan && row.slice_plan.childCount > 1) return "sliced";
  return "normal";
}

const PHASE_LABELS: Record<string, string> = {
  conviction_bonus: "Conviction bonus",
  risk_parity: "Risk parity",
  baseline: "Baseline sizing",
  chandelier: "Chandelier stop",
  scale_out: "Scale-out / TP",
  time_stop: "Time stop",
  stop_loss: "Stop-loss",
  trail: "Trailing stop",
  event_exit: "Event blackout exit",
  rebalance_trim: "Rebalance trim",
  ai_sell: "Discretionary AI sell",
  other: "Other",
  tod_blocked: "TOD blocked",
  tod_haircut: "TOD haircut",
  sliced: "Sliced order",
  normal: "Normal execution",
  unknown: "Unknown",
};

function rollup(entries: Array<{ key: string; pnl: number }>): AttributionSlice[] {
  const groups = new Map<string, number[]>();
  for (const e of entries) {
    const arr = groups.get(e.key) ?? [];
    arr.push(e.pnl);
    groups.set(e.key, arr);
  }
  return Array.from(groups.entries())
    .map(([key, pnls]) => {
      const wins = pnls.filter((p) => p > 0).length;
      const total = pnls.reduce((a, b) => a + b, 0);
      return {
        key,
        label: PHASE_LABELS[key] ?? key,
        realizedPnl: total,
        trips: pnls.length,
        winRatePct: pnls.length ? (wins / pnls.length) * 100 : null,
        avgPnl: pnls.length ? total / pnls.length : null,
      } satisfies AttributionSlice;
    })
    .sort((a, b) => b.realizedPnl - a.realizedPnl);
}

function toEquityCurve(rows: EquityPoint[]): EquityCurvePoint[] {
  return rows.map((r) => ({ date: r.snapshot_date, equity: Number(r.total_value) }));
}

function toDrawdownCurve(rows: EquityPoint[]): DrawdownPoint[] {
  let peak = -Infinity;
  return rows.map((r) => {
    const v = Number(r.total_value);
    if (v > peak) peak = v;
    const dd = peak > 0 ? ((v - peak) / peak) * 100 : 0;
    return { date: r.snapshot_date, equity: v, peak, drawdownPct: dd };
  });
}

export async function getPerformanceAnalytics(
  portfolioId: string,
  windowDays: number,
  owned: OwnedDbClient,
): Promise<PerformanceAnalytics> {
  const db = owned.db;
  const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const sinceDate = sinceIso.slice(0, 10);

  const [pf, snaps, tradesRes, decisionsRes] = await Promise.all([
    db.from("portfolios").select("id, currency").eq("id", portfolioId).maybeSingle(),
    db
      .from("equity_snapshots")
      .select("snapshot_date, total_value")
      .eq("portfolio_id", portfolioId)
      .gte("snapshot_date", sinceDate)
      .order("snapshot_date", { ascending: true }),
    db
      .from("trades")
      .select("symbol, side, quantity, price, trade_date, executed_at, reason")
      .eq("portfolio_id", portfolioId)
      .gte("executed_at", sinceIso)
      .order("executed_at", { ascending: true }),
    db
      .from("decisions")
      .select("run_date, raw")
      .eq("portfolio_id", portfolioId)
      .gte("run_date", sinceDate)
      .order("run_date", { ascending: true }),
  ]);

  if (pf.error) throw new Error(pf.error.message);
  if (!pf.data) throw new Error("Portfolio not found");
  const currency = (pf.data.currency as string) ?? "GBP";

  const equity: EquityPoint[] = (snaps.data ?? []).map((r) => ({
    snapshot_date: r.snapshot_date as string,
    total_value: Number(r.total_value),
  }));
  const trades: TradeRow[] = (tradesRes.data ?? []).map((r) => ({
    symbol: r.symbol as string,
    side: r.side as "buy" | "sell",
    quantity: Number(r.quantity),
    price: Number(r.price),
    trade_date: r.trade_date as string,
    executed_at: (r.executed_at as string) ?? null,
  }));
  const tradeReasons = new Map<string, string>();
  for (const r of tradesRes.data ?? []) {
    tradeReasons.set(
      `${r.trade_date}|${r.symbol}|${r.side}|${Number(r.price).toFixed(6)}`,
      (r.reason as string) ?? "",
    );
  }

  // Index decisions by (run_date, symbol, side) → list of executed rows.
  const decisionIndex = new Map<string, DecisionExecutedRow[]>();
  const regimeByDate = new Map<string, string>();
  for (const d of decisionsRes.data ?? []) {
    const raw = (d.raw ?? {}) as DecisionRaw;
    const runDate = d.run_date as string;
    if (raw.regime?.regime) regimeByDate.set(runDate, raw.regime.regime);
    for (const ex of raw.executed ?? []) {
      const key = `${runDate}|${ex.symbol}|${ex.side}`;
      const arr = decisionIndex.get(key) ?? [];
      arr.push(ex);
      decisionIndex.set(key, arr);
    }
  }

  function findExecRow(date: string, symbol: string, side: "buy" | "sell", qty: number, price: number) {
    const rows = decisionIndex.get(`${date}|${symbol}|${side}`);
    if (!rows || rows.length === 0) return undefined;
    // Best-effort: match by closest (qty, price).
    let best: DecisionExecutedRow | undefined;
    let bestScore = Infinity;
    for (const r of rows) {
      const score = Math.abs(r.quantity - qty) / Math.max(qty, 1e-9) + Math.abs(r.price - price) / Math.max(price, 1e-9);
      if (score < bestScore) { bestScore = score; best = r; }
    }
    return best;
  }

  // FIFO round-trip attribution.
  const lotsBySymbol = new Map<string, BuyLot[]>();
  const regimeEntries: Array<{ key: string; pnl: number }> = [];
  const sizingEntries: Array<{ key: string; pnl: number }> = [];
  const exitEntries: Array<{ key: string; pnl: number }> = [];
  const executionEntries: Array<{ key: string; pnl: number }> = [];

  for (const t of trades) {
    if (t.side === "buy") {
      const execRow = findExecRow(t.trade_date, t.symbol, "buy", t.quantity, t.price);
      const sizing = classifySizing(execRow?.reason ?? "");
      const execution = classifyExecution(execRow);
      const regime = regimeByDate.get(t.trade_date) ?? "unknown";
      const lots = lotsBySymbol.get(t.symbol) ?? [];
      lots.push({ qty: t.quantity, price: t.price, date: t.trade_date, regime, sizing, execution });
      lotsBySymbol.set(t.symbol, lots);
      continue;
    }
    // SELL
    const lots = lotsBySymbol.get(t.symbol) ?? [];
    let remaining = t.quantity;
    const sellReason = tradeReasons.get(`${t.trade_date}|${t.symbol}|sell|${t.price.toFixed(6)}`) ?? "";
    const exitKind = classifyExit(sellReason);
    const sellExec = findExecRow(t.trade_date, t.symbol, "sell", t.quantity, t.price);
    const sellExecution = classifyExecution(sellExec);
    while (remaining > 1e-9 && lots.length > 0) {
      const lot = lots[0];
      const matched = Math.min(remaining, lot.qty);
      const pnl = (t.price - lot.price) * matched;
      // Regime + sizing from entry lot; exit from sell reason; execution = worst of buy/sell.
      regimeEntries.push({ key: lot.regime || "unknown", pnl });
      sizingEntries.push({ key: lot.sizing, pnl });
      exitEntries.push({ key: exitKind, pnl });
      // Execution priority: blocked > haircut > sliced > normal (pick more informative side).
      const priority = ["tod_blocked", "tod_haircut", "sliced", "normal"];
      const bestExec = [lot.execution, sellExecution].sort(
        (a, b) => priority.indexOf(a) - priority.indexOf(b),
      )[0];
      executionEntries.push({ key: bestExec, pnl });
      lot.qty -= matched;
      remaining -= matched;
      if (lot.qty <= 1e-9) lots.shift();
    }
    lotsBySymbol.set(t.symbol, lots);
  }

  const equityCurve = toEquityCurve(equity);
  const drawdownCurve = toDrawdownCurve(equity);
  const dd = computeMaxDrawdown(equity);
  const startingEquity = equity.length ? Number(equity[0].total_value) : null;
  const endingEquity = equity.length ? Number(equity[equity.length - 1].total_value) : null;
  const totalReturnPct =
    startingEquity && startingEquity > 0 && endingEquity != null
      ? ((endingEquity - startingEquity) / startingEquity) * 100
      : null;
  const totalRealized = regimeEntries.reduce((a, b) => a + b.pnl, 0);

  return {
    windowDays,
    currency,
    startingEquity,
    endingEquity,
    totalReturnPct,
    maxDrawdownPct: dd.pct,
    maxDrawdownPeakDate: dd.peakDate,
    maxDrawdownTroughDate: dd.troughDate,
    totalRealizedPnl: totalRealized,
    roundTrips: regimeEntries.length,
    equityCurve,
    drawdownCurve,
    trades: trades.map((t) => ({
      symbol: t.symbol,
      side: t.side,
      quantity: Number(t.quantity),
      price: Number(t.price),
      trade_date: t.trade_date,
      executed_at: t.executed_at ?? null,
    })),
    regimeAttribution: rollup(regimeEntries),
    sizingAttribution: rollup(sizingEntries),
    exitAttribution: rollup(exitEntries),
    executionAttribution: rollup(executionEntries),
  };
}
