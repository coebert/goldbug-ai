// Multi-day AI backtest runner.
//
// Replays the app's own decision rule-set (`buildHeuristicBuys` /
// `buildHeuristicSells` — the same logic the trading engine falls back
// to, driven by the same RSI / 5d / 30d / MACD feature set) over a tape
// of historical daily bars, starting from a small cash pot (£1,000 by
// default) and executing through the pure `broker-simulator` so the
// no-borrow / no-short invariants hold on every step.
//
// Output is the two things you actually need to judge a run:
//   - `equityCurve`  one mark-to-market point per bar, no-trade days
//                    included, so the curve is continuous and chartable
//   - `tradeLog`     one row per executed fill, with the reason the
//                    rule-set gave, the fill price, fees, realized PnL
//                    and the cash/equity left afterwards
//
// Pure and deterministic: same bars in ⇒ byte-identical curve and log.
// Metric aggregation lives in `backtest-metrics`; a convenience
// `summary` is attached using that module so callers don't re-derive it.

import { runBacktest, type BacktestBar } from "./backtest-runner";
import {
  buildHeuristicBuys,
  buildHeuristicSells,
  normalizeHeuristicRiskLevel,
  type HeuristicRiskLevelInput,
} from "./heuristic-decision";
import {
  computeBacktestMetrics,
  computeMaxDrawdown,
  computeSharpe,
  computeAnnualisedVolPct,
  dailyReturns,
  type BacktestMetrics,
  type EquityPoint,
  type TradeRow,
} from "./backtest-metrics";
import { featuresFrom } from "./risk-sim-matrix";
import type { Frictions, SimDecision, SimHolding } from "./broker-simulator";

export type { BacktestBar } from "./backtest-runner";

/** Bars of history the feature set needs before any decision is trusted. */
export const AI_BACKTEST_WARMUP_BARS = 31;

export type AiBacktestOptions = {
  /** Opening cash in portfolio currency. Defaults to £1,000. */
  startingCash?: number;
  /** conservative | balanced | aggressive (low/high also accepted). */
  riskLevel?: HeuristicRiskLevelInput;
  /** Flat fee charged on every fill. Defaults to 0. */
  feePerTrade?: number;
  /** Commission / slippage / tax model passed to the simulator. */
  frictions?: Frictions;
  /**
   * Allow fractional units. A £1,000 pot sizing an 8% sleeve into a
   * £180 share can't buy a whole share, so fractional is the default —
   * set `false` to model a whole-share-only venue.
   */
  fractionalShares?: boolean;
  /** Smallest notional worth placing. Defaults to 1 currency unit. */
  minTicketNotional?: number;
  /** Override the warm-up window (bars ignored before trading starts). */
  warmupBars?: number;
};

export type AiTradeLogRow = {
  /** 1-based sequence across the whole run. */
  seq: number;
  date: string;
  barIndex: number;
  symbol: string;
  side: "buy" | "sell";
  /** Units actually filled (may be below `requestedQuantity`). */
  quantity: number;
  requestedQuantity: number;
  partial: boolean;
  /** Why the fill was truncated, when it was. */
  truncationReason: "liquidity" | "cash" | "position" | null;
  price: number;
  /** Quoted close the decision was sized against. */
  expectedPrice: number;
  fee: number;
  /** quantity * price, before fees. */
  notional: number;
  /** Realized PnL booked on a SELL; 0 on a BUY. */
  realizedPnl: number;
  cashAfter: number;
  equityAfter: number;
  /** Plain-English reason emitted by the decision rule-set. */
  reason: string;
};

export type AiBacktestEquityPoint = {
  date: string;
  barIndex: number;
  cash: number;
  holdingsValue: number;
  totalValue: number;
  /** Cumulative return vs the opening pot, in %. */
  returnPct: number;
  /** Fills executed on this bar. */
  trades: number;
};

export type AiBacktestSummary = BacktestMetrics & {
  startingCash: number;
  endingEquity: number;
  endingCash: number;
  cagrPct: number;
  calmar: number;
  buys: number;
  sells: number;
  feesPaid: number;
  bars: number;
  openPositions: number;
};

export type AiBacktestResult = {
  riskLevel: "conservative" | "balanced" | "aggressive";
  startingCash: number;
  equityCurve: AiBacktestEquityPoint[];
  tradeLog: AiTradeLogRow[];
  finalHoldings: SimHolding[];
  /** Decisions the simulator refused, with the broker-style reason. */
  rejections: Array<{ date: string; symbol: string; side: string; reason: string }>;
  summary: AiBacktestSummary;
};

function sizeQuantity(
  spend: number,
  price: number,
  fractional: boolean,
  minTicket: number,
): number {
  if (!(price > 0) || !(spend > 0)) return 0;
  const raw = spend / price;
  const qty = fractional ? raw : Math.floor(raw);
  if (!(qty > 0)) return 0;
  return qty * price >= minTicket ? qty : 0;
}

/**
 * Replay `bars` through the AI decision rule-set from a standing start.
 */
export async function runAiBacktest(
  bars: BacktestBar[],
  options: AiBacktestOptions = {},
): Promise<AiBacktestResult> {
  const startingCash =
    Number.isFinite(options.startingCash) && (options.startingCash as number) > 0
      ? (options.startingCash as number)
      : 1000;
  const riskLevel = normalizeHeuristicRiskLevel(options.riskLevel);
  const feePerTrade = Math.max(0, options.feePerTrade ?? 0);
  const fractional = options.fractionalShares ?? true;
  const minTicket = Math.max(0, options.minTicketNotional ?? 1);
  const warmup = Math.max(0, options.warmupBars ?? AI_BACKTEST_WARMUP_BARS);

  // Decision id → the rule-set's own explanation, so the trade log can
  // say WHY each fill happened rather than just that it did.
  const reasons = new Map<string, string>();

  const result = await runBacktest(
    { cash: startingCash, holdings: [] },
    bars,
    ({ state, closes, history, barIndex }) => {
      if (barIndex < warmup) return [];
      const feats = featuresFrom(history);
      const holdings = state.holdings
        .filter((h) => h.quantity > 0)
        .map((h) => ({ symbol: h.symbol, quantity: h.quantity }));
      const decisions: SimDecision[] = [];

      // Exits first — they free cash for the same bar's entries.
      for (const s of buildHeuristicSells(holdings, feats)) {
        const price = closes[s.symbol];
        if (!(price > 0) || !(s.quantity > 0)) continue;
        const id = `${barIndex}-s-${s.symbol}`;
        reasons.set(id, s.reason);
        decisions.push({ id, symbol: s.symbol, side: "SELL", quantity: s.quantity, price });
      }

      const exiting = new Set(decisions.map((d) => d.symbol));
      const buyList = buildHeuristicBuys(holdings, feats, {
        cashValue: state.cash,
        riskLevel,
      });
      for (const b of buyList) {
        if (exiting.has(b.symbol)) continue;
        const price = closes[b.symbol];
        // Fees come out of the same pot, so size against cash net of them.
        const spend = Math.max(0, state.cash * (b.percent / 100) - feePerTrade);
        const qty = sizeQuantity(spend, price, fractional, minTicket);
        if (qty <= 0) continue;
        const id = `${barIndex}-b-${b.symbol}`;
        reasons.set(id, b.reason);
        decisions.push({ id, symbol: b.symbol, side: "BUY", quantity: qty, price });
      }
      return decisions;
    },
    {
      defaultFee: feePerTrade,
      simulator: options.frictions ? { frictions: options.frictions } : undefined,
    },
  );

  // ---- equity curve ---------------------------------------------------
  const equityCurve: AiBacktestEquityPoint[] = result.equityCurve.map((p) => ({
    date: p.date,
    barIndex: p.barIndex,
    cash: p.cash,
    holdingsValue: p.holdingsValue,
    totalValue: p.totalValue,
    returnPct: (p.totalValue / startingCash - 1) * 100,
    trades: p.steps,
  }));

  // ---- trade log ------------------------------------------------------
  const equityByDate = new Map(equityCurve.map((p) => [p.date, p.totalValue] as const));
  const tradeLog: AiTradeLogRow[] = result.snapshots
    .filter((s) => s.fillQuantity > 0)
    .map((s, i) => ({
      seq: i + 1,
      date: s.date,
      barIndex: s.barIndex,
      symbol: s.symbol,
      side: s.side === "BUY" ? ("buy" as const) : ("sell" as const),
      quantity: s.fillQuantity,
      requestedQuantity: s.requestedQuantity,
      partial: s.partial,
      truncationReason: s.truncationReason,
      price: s.fillPrice,
      expectedPrice: s.expectedPrice,
      fee: s.fee,
      notional: s.fillQuantity * s.fillPrice,
      realizedPnl: s.realizedPnl,
      cashAfter: s.cash,
      equityAfter: s.totalValue,
      reason: reasons.get(s.decisionId) ?? "",
    }));

  // ---- summary --------------------------------------------------------
  const equity: EquityPoint[] = equityCurve.map((p) => ({
    snapshot_date: p.date,
    total_value: p.totalValue,
  }));
  const tradeRows: TradeRow[] = tradeLog.map((t) => ({
    trade_date: t.date,
    side: t.side,
    symbol: t.symbol,
    quantity: t.quantity,
    price: t.price,
  }));
  const base = computeBacktestMetrics(equity, tradeRows, startingCash);
  const endingEquity = equityCurve.at(-1)?.totalValue ?? startingCash;
  const years = bars.length / 252;
  const cagr = years > 0 && startingCash > 0 ? (endingEquity / startingCash) ** (1 / years) - 1 : 0;
  const ddAbs = Math.abs(computeMaxDrawdown(equity).pct);
  const rets = dailyReturns(equity);

  const summary: AiBacktestSummary = {
    ...base,
    // Recomputed from the same curve so summary + curve can never disagree.
    sharpe: computeSharpe(rets),
    volatilityPct: computeAnnualisedVolPct(rets),
    startingCash,
    endingEquity,
    endingCash: result.finalState.cash,
    cagrPct: cagr * 100,
    calmar: ddAbs > 1e-9 ? (cagr * 100) / ddAbs : 0,
    buys: tradeLog.filter((t) => t.side === "buy").length,
    sells: tradeLog.filter((t) => t.side === "sell").length,
    feesPaid: tradeLog.reduce((a, t) => a + t.fee, 0),
    bars: bars.length,
    openPositions: result.finalState.holdings.filter((h) => h.quantity > 0).length,
  };

  return {
    riskLevel,
    startingCash,
    equityCurve,
    tradeLog,
    finalHoldings: result.finalState.holdings.filter((h) => h.quantity > 0).map((h) => ({ ...h })),
    rejections: result.rejections.map((r) => ({
      date: r.date,
      symbol: r.symbol,
      side: r.side,
      reason: r.reason,
    })),
    summary,
  };
}
