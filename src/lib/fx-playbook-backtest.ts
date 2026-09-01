// Historical replay of the FX funding-leg playbook (see fx-leg-playbook.ts).
//
// Before any of these rules govern real cash we need to know what they would
// have done over years of tape: how often the +2.0% take line is reached
// before the −1.5% cut line, how deep the worst run of losses gets, and how
// much of the edge round-trip spread eats. Pure module — the server function
// supplies the daily closes.

import { FX_PLAYBOOK } from "./fx-leg-playbook";

export type FxBar = { date: string; rate: number };

export type FxBacktestConfig = {
  /** "short" = short the base ccy (the usual funding leg), "long" = long base. */
  side: "short" | "long";
  /** Bars to hold before force-closing an undecided leg. */
  maxHoldDays: number;
  /** Bars to wait after a close before opening the next leg. */
  cooldownDays: number;
  /** Round-trip execution cost in basis points of notional. */
  costBps: number;
  stopLossPct: number;
  takeProfitPct: number;
};

export const DEFAULT_FX_BACKTEST: FxBacktestConfig = {
  side: "short",
  maxHoldDays: 30,
  cooldownDays: 2,
  costBps: 6,
  stopLossPct: FX_PLAYBOOK.stopLossPct,
  takeProfitPct: FX_PLAYBOOK.takeProfitPct,
};

export type FxBacktestTrade = {
  entryDate: string;
  exitDate: string;
  entryRate: number;
  exitRate: number;
  holdDays: number;
  /** Net return of the leg after costs, as a fraction of notional. */
  pnlPct: number;
  reason: "take_profit" | "stop_loss" | "max_hold" | "end_of_data";
};

export type FxBacktestResult = {
  pair: string;
  bars: number;
  from: string | null;
  to: string | null;
  trades: FxBacktestTrade[];
  tradeCount: number;
  winRate: number;
  avgPnlPct: number;
  /** Compounded return of trading one unit of notional per leg. */
  totalReturnPct: number;
  maxDrawdownPct: number;
  worstTradePct: number;
  /** Mean of the worst 5% of trades. */
  cvar5Pct: number;
  hitTakeProfit: number;
  hitStopLoss: number;
  timedOut: number;
  /** Compounding equity curve (starts at 1) sampled at each trade close. */
  equityCurve: Array<{ date: string; equity: number }>;
};

/** P&L as a fraction of notional, matching valueFxLeg / evaluateFxLegPlaybook. */
export function legPnlPct(side: "short" | "long", entryRate: number, rate: number): number {
  if (!(entryRate > 0) || !(rate > 0)) return 0;
  const qty = side === "short" ? -1 : 1;
  const pnlQuote = qty * (rate - entryRate);
  return pnlQuote / rate;
}

export function runFxPlaybookBacktest(
  pair: string,
  bars: FxBar[],
  cfgIn: Partial<FxBacktestConfig> = {},
): FxBacktestResult {
  const cfg: FxBacktestConfig = { ...DEFAULT_FX_BACKTEST, ...cfgIn };
  const clean = bars
    .filter((b) => Number.isFinite(b.rate) && b.rate > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const trades: FxBacktestTrade[] = [];
  const costPct = cfg.costBps / 10_000;

  let i = 0;
  while (i < clean.length - 1) {
    const entry = clean[i]!;
    let exitIdx = -1;
    let reason: FxBacktestTrade["reason"] = "end_of_data";
    for (let j = i + 1; j < clean.length; j++) {
      const gross = legPnlPct(cfg.side, entry.rate, clean[j]!.rate);
      if (gross >= cfg.takeProfitPct) {
        exitIdx = j;
        reason = "take_profit";
        break;
      }
      if (gross <= cfg.stopLossPct) {
        exitIdx = j;
        reason = "stop_loss";
        break;
      }
      if (j - i >= cfg.maxHoldDays) {
        exitIdx = j;
        reason = "max_hold";
        break;
      }
    }
    if (exitIdx < 0) {
      exitIdx = clean.length - 1;
      reason = "end_of_data";
    }
    const exit = clean[exitIdx]!;
    trades.push({
      entryDate: entry.date,
      exitDate: exit.date,
      entryRate: entry.rate,
      exitRate: exit.rate,
      holdDays: exitIdx - i,
      pnlPct: legPnlPct(cfg.side, entry.rate, exit.rate) - costPct,
      reason,
    });
    i = exitIdx + Math.max(1, cfg.cooldownDays);
  }

  const pnls = trades.map((t) => t.pnlPct);
  const wins = pnls.filter((p) => p > 0).length;
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  const equityCurve: Array<{ date: string; equity: number }> = [];
  for (const t of trades) {
    equity *= 1 + t.pnlPct;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - equity) / peak : 0);
    equityCurve.push({ date: t.exitDate, equity });
  }

  const sorted = [...pnls].sort((a, b) => a - b);
  const tailN = Math.max(1, Math.ceil(sorted.length * 0.05));
  const cvar5 = sorted.length
    ? sorted.slice(0, tailN).reduce((s, v) => s + v, 0) / tailN
    : 0;

  return {
    pair,
    bars: clean.length,
    from: clean[0]?.date ?? null,
    to: clean[clean.length - 1]?.date ?? null,
    trades,
    tradeCount: trades.length,
    winRate: trades.length ? wins / trades.length : 0,
    avgPnlPct: pnls.length ? pnls.reduce((s, v) => s + v, 0) / pnls.length : 0,
    totalReturnPct: equity - 1,
    maxDrawdownPct: maxDd,
    worstTradePct: sorted[0] ?? 0,
    cvar5Pct: cvar5,
    hitTakeProfit: trades.filter((t) => t.reason === "take_profit").length,
    hitStopLoss: trades.filter((t) => t.reason === "stop_loss").length,
    timedOut: trades.filter((t) => t.reason === "max_hold").length,
    equityCurve,
  };
}

export type FxBacktestMoney = {
  /** Cash the sizing is based on, in the portfolio's base currency. */
  capital: number;
  /** Notional multiplier applied to that cash on each leg. */
  leverage: number;
  /** Notional of the first leg (capital x leverage) — later legs compound. */
  startingNotional: number;
  finalEquity: number;
  totalPnl: number;
  avgLegPnl: number;
  bestLegPnl: number;
  worstLegPnl: number;
  /** Mean money loss of the worst 5% of legs. */
  cvar5Pnl: number;
  /** Deepest peak-to-trough fall of the cash balance. */
  maxDrawdown: number;
  /** Cash curve (starts at `capital`) sampled at each leg close. */
  cashCurve: Array<{ date: string; cash: number }>;
};

/**
 * Restates a percentage backtest in real money: each leg is sized at
 * `equity x leverage` of notional, so the P&L, drawdown and tail figures are
 * the actual pounds the portfolio would have gained or lost — not abstract
 * per-unit percentages.
 */
export function sizeFxBacktest(
  result: Pick<FxBacktestResult, "trades">,
  opts: { capital: number; leverage?: number },
): FxBacktestMoney {
  const capital = Number.isFinite(opts.capital) && opts.capital > 0 ? opts.capital : 0;
  const leverage = Number.isFinite(opts.leverage) && (opts.leverage ?? 0) > 0 ? opts.leverage! : 1;

  let equity = capital;
  let peak = capital;
  let maxDd = 0;
  const legPnls: number[] = [];
  const cashCurve: Array<{ date: string; cash: number }> = [];

  for (const t of result.trades) {
    // Notional scales with the surviving balance, so gains compound and a
    // drawdown automatically shrinks the next ticket.
    const notional = Math.max(0, equity) * leverage;
    const pnl = notional * t.pnlPct;
    equity += pnl;
    legPnls.push(pnl);
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    cashCurve.push({ date: t.exitDate, cash: equity });
  }

  const sorted = [...legPnls].sort((a, b) => a - b);
  const tailN = Math.max(1, Math.ceil(sorted.length * 0.05));
  const cvar5 = sorted.length ? sorted.slice(0, tailN).reduce((s, v) => s + v, 0) / tailN : 0;

  return {
    capital,
    leverage,
    startingNotional: capital * leverage,
    finalEquity: equity,
    totalPnl: equity - capital,
    avgLegPnl: legPnls.length ? legPnls.reduce((s, v) => s + v, 0) / legPnls.length : 0,
    bestLegPnl: sorted.length ? sorted[sorted.length - 1]! : 0,
    worstLegPnl: sorted[0] ?? 0,
    cvar5Pnl: cvar5,
    maxDrawdown: maxDd,
    cashCurve,
  };
}
