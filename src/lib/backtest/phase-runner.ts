// Phase 2–6 backtest runner.
//
// Replays a set of daily OHLC series through the same guardrails/overlays
// that the live engine uses (Phase 2 earnings blackout, Phase 3 ATR trailing
// stop, Phase 4 VWAP slicing cost model, Phase 5 correlation-cluster cap,
// Phase 6 tail-hedge overlay) and reports CAGR, max drawdown, win rate, and
// per-module contribution (leave-one-out CAGR delta).
//
// The runner is intentionally pure: no I/O, no dates outside the caller's
// data. Signals are supplied as a Record<symbol, "buy"|"sell"|"hold"> for
// each day so the engine can be driven by any alpha model (or by unit tests).

import { evaluateEarningsWindow, DEFAULT_EARNINGS_WINDOW } from "@/lib/events/earnings-window";
import {
  computeTrailingStop,
  advanceTrailingStop,
  DEFAULT_TRAILING_STOP,
  type TrailingStopState,
  type Bar,
} from "@/lib/exits/atr-trailing-stop";
import {
  clusterByCorrelation,
  correlationMatrix,
  sizeAgainstClusterCap,
} from "@/lib/sizing/correlation-cluster";
import { computeTailHedge } from "@/lib/hedging/tail-hedge";
import { sizeHedgeBuy, sizeHedgeSell } from "@/lib/hedging/tail-hedge-sizing";


export type DailyBar = { date: string } & Bar;

export type SymbolSeries = {
  symbol: string;
  bars: DailyBar[];
  earnings?: string[]; // ISO dates of upcoming earnings prints
};

export type DayContext = {
  date: string;                       // ISO YYYY-MM-DD
  nav: number;                        // portfolio NAV at close of prior day
  weights: Record<string, number>;    // fractional weight per symbol
  cash: number;
};

export type Signal = "buy" | "sell" | "hold";

export type SignalFn = (ctx: DayContext, symbol: string) => Signal;

export type PhaseFlags = {
  earnings: boolean;  // Phase 2
  trailing: boolean;  // Phase 3
  slicing: boolean;   // Phase 4 (cost model: reduces per-trade slippage)
  cluster: boolean;   // Phase 5
  hedge: boolean;     // Phase 6
};

export const ALL_PHASES_ON: PhaseFlags = {
  earnings: true, trailing: true, slicing: true, cluster: true, hedge: true,
};
export const ALL_PHASES_OFF: PhaseFlags = {
  earnings: false, trailing: false, slicing: false, cluster: false, hedge: false,
};

export type RunnerConfig = {
  initialCash: number;
  targetWeightPerBuy: number;      // e.g. 0.10 = 10% NAV per new buy
  clusterCap: number;              // e.g. 0.35
  baseFeeBps: number;              // e.g. 10 (each side)
  baseSlippageBps: number;         // e.g. 10 (each side, immediate market)
  slicingSlippageBps: number;      // e.g. 4 (each side under VWAP/TWAP)
  cape?: number | null;            // used by Phase 6
  regime?: string | null;          // used by Phase 6
  /** Symbol used as the tail-hedge proxy (must be in `series`). Default "GLD". */
  hedgeSymbol?: string;
  /** Fraction of cash kept as safety on hedge buys (mirrors executor). */
  hedgeCashBufferPct?: number;
};

export const DEFAULT_CONFIG: RunnerConfig = {
  initialCash: 100_000,
  targetWeightPerBuy: 0.1,
  clusterCap: 0.35,
  baseFeeBps: 10,
  baseSlippageBps: 10,
  slicingSlippageBps: 4,
  cape: 25,
  regime: "bull_quiet",
  hedgeSymbol: "GLD",
  hedgeCashBufferPct: 0.01,
};

export type Trade = {
  date: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  costBps: number;
  reason: string;
};

export type EquityPoint = { date: string; equity: number };

export type RunMetrics = {
  cagr: number;
  maxDrawdown: number;
  winRate: number;
  totalReturn: number;
  trades: number;
  finalEquity: number;
};

export type RunResult = {
  metrics: RunMetrics;
  equity: EquityPoint[];
  trades: Trade[];
  flags: PhaseFlags;
};

export type BacktestOutput = {
  full: RunResult;
  baseline: RunResult;                      // all phases OFF
  contributions: Record<keyof PhaseFlags, {
    cagrDelta: number;                      // full − leaveOneOut
    ddDelta: number;                        // leaveOneOut − full (positive = phase reduced drawdown)
    winRateDelta: number;
  }>;
};

// --- helpers ---------------------------------------------------------------

function unionDates(series: SymbolSeries[]): string[] {
  const s = new Set<string>();
  for (const sym of series) for (const b of sym.bars) s.add(b.date);
  return Array.from(s).sort();
}

function indexBySymbol(series: SymbolSeries[]): Map<string, Map<string, DailyBar>> {
  const m = new Map<string, Map<string, DailyBar>>();
  for (const s of series) {
    const inner = new Map<string, DailyBar>();
    for (const b of s.bars) inner.set(b.date, b);
    m.set(s.symbol, inner);
  }
  return m;
}

function dailyReturns(bars: DailyBar[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1].close;
    r.push(p > 0 ? bars[i].close / p - 1 : 0);
  }
  return r;
}

function computeCagr(equity: EquityPoint[]): number {
  if (equity.length < 2) return 0;
  const start = equity[0].equity;
  const end = equity[equity.length - 1].equity;
  if (start <= 0) return 0;
  const days = (new Date(equity[equity.length - 1].date).getTime() -
    new Date(equity[0].date).getTime()) / 86_400_000;
  const years = Math.max(days / 365.25, 1 / 365.25);
  return Math.pow(end / start, 1 / years) - 1;
}

function computeMaxDD(equity: EquityPoint[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const p of equity) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = (peak - p.equity) / peak;
      if (dd > mdd) mdd = dd;
    }
  }
  return mdd;
}

// FIFO round-trip win rate.
function computeWinRate(trades: Trade[]): number {
  const lots: Record<string, { qty: number; price: number }[]> = {};
  let wins = 0, total = 0;
  for (const t of trades) {
    if (t.side === "buy") {
      (lots[t.symbol] ??= []).push({ qty: t.qty, price: t.price });
    } else {
      let remaining = t.qty;
      const bucket = lots[t.symbol] ?? [];
      while (remaining > 1e-9 && bucket.length) {
        const lot = bucket[0];
        const take = Math.min(remaining, lot.qty);
        total += 1;
        if (t.price > lot.price) wins += 1;
        lot.qty -= take;
        remaining -= take;
        if (lot.qty <= 1e-9) bucket.shift();
      }
    }
  }
  return total > 0 ? wins / total : 0;
}

// --- core replay -----------------------------------------------------------

type Position = {
  qty: number;
  entryPrice: number;
  entryDate: string;
  entryBar: DailyBar;
  stop: TrailingStopState | null;
  prevClose: number;
};

function buildCorrelationClusters(series: SymbolSeries[]): string[][] {
  const returns: Record<string, number[]> = {};
  for (const s of series) returns[s.symbol] = dailyReturns(s.bars);
  const mat = correlationMatrix(returns);
  return clusterByCorrelation(mat, 0.7);
}

export function runPhaseBacktest(
  series: SymbolSeries[],
  signalFn: SignalFn,
  flags: PhaseFlags = ALL_PHASES_ON,
  cfg: RunnerConfig = DEFAULT_CONFIG,
): RunResult {
  const dates = unionDates(series);
  const bySym = indexBySymbol(series);
  const clusters = flags.cluster ? buildCorrelationClusters(series) : [];
  const earningsBySym: Record<string, string[]> = {};
  for (const s of series) earningsBySym[s.symbol] = s.earnings ?? [];


  const positions: Record<string, Position> = {};
  let cash = cfg.initialCash;
  // Phase 6 hedge state — priced against a real symbol so fills mirror the
  // executor: qty is tracked, buys pay cash (minus a buffer), sells return
  // cash, both incur the same fee/slippage bps as any other trade.
  const hedgeSymbol = cfg.hedgeSymbol ?? DEFAULT_CONFIG.hedgeSymbol!;
  const hedgeBufferPct = cfg.hedgeCashBufferPct ?? DEFAULT_CONFIG.hedgeCashBufferPct!;
  const hedgeHasSeries = bySym.has(hedgeSymbol);
  let hedgeQty = 0;
  let hedgePrevClose = 0;
  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];

  const perSideCostBps = (sliced: boolean): number =>
    cfg.baseFeeBps + (sliced ? cfg.slicingSlippageBps : cfg.baseSlippageBps);

  const hedgePriceOn = (date: string): number => {
    const bar = bySym.get(hedgeSymbol)?.get(date);
    return bar?.close ?? hedgePrevClose;
  };
  const hedgeMv = (date: string): number => hedgeQty * hedgePriceOn(date);

  for (const date of dates) {
    // Mark-to-market at today's close, then act.
    let mv = 0;
    for (const [sym, pos] of Object.entries(positions)) {
      const bar = bySym.get(sym)?.get(date);
      if (bar) mv += pos.qty * bar.close;
      else mv += pos.qty * pos.prevClose;
    }
    const nav = cash + mv + hedgeMv(date);

    // Phase 3: advance trailing stops using today's bar; force-exit if hit.
    if (flags.trailing) {
      for (const [sym, pos] of Object.entries(positions)) {
        const bar = bySym.get(sym)?.get(date);
        if (!bar) continue;
        pos.stop = pos.stop
          ? advanceTrailingStop(pos.stop, bar, pos.prevClose)
          : computeTrailingStop([pos.entryBar, bar], pos.entryPrice);
        if (pos.stop?.triggered) {
          const bps = perSideCostBps(flags.slicing);
          const proceeds = pos.qty * bar.close * (1 - bps / 10_000);
          cash += proceeds;
          trades.push({
            date, symbol: sym, side: "sell", qty: pos.qty, price: bar.close,
            costBps: bps, reason: `trailing stop hit @ ${pos.stop.stop_price.toFixed(2)}`,
          });
          delete positions[sym];
        }
      }
    }

    // Compute weights snapshot for cluster gating.
    const weights: Record<string, number> = {};
    if (nav > 0) {
      for (const [sym, pos] of Object.entries(positions)) {
        const bar = bySym.get(sym)?.get(date);
        const px = bar?.close ?? pos.prevClose;
        weights[sym] = (pos.qty * px) / nav;
      }
    }

    // Evaluate signals for every symbol with a bar today.
    for (const s of series) {
      // When Phase 6 owns the hedge symbol, don't let external signals fight
      // the overlay for the same instrument.
      if (flags.hedge && s.symbol === hedgeSymbol) continue;
      const bar = bySym.get(s.symbol)?.get(date);
      if (!bar) continue;
      const sig = signalFn({ date, nav, weights, cash }, s.symbol);
      if (sig === "hold") continue;

      // Phase 2: earnings window.
      let sizeMult = 1;
      if (flags.earnings) {
        const upcoming = (earningsBySym[s.symbol] ?? [])
          .map((d) => new Date(d))
          .filter((d) => d.getTime() >= new Date(date).getTime())
          .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
        const dec = evaluateEarningsWindow(upcoming, new Date(date), sig, DEFAULT_EARNINGS_WINDOW);
        if (dec.action === "block") continue;
        sizeMult = dec.size_multiplier;
      }

      if (sig === "sell") {
        const pos = positions[s.symbol];
        if (!pos) continue;
        const qty = pos.qty * sizeMult;
        if (qty <= 0) continue;
        const bps = perSideCostBps(flags.slicing);
        cash += qty * bar.close * (1 - bps / 10_000);
        pos.qty -= qty;
        trades.push({
          date, symbol: s.symbol, side: "sell", qty, price: bar.close, costBps: bps,
          reason: "signal sell",
        });
        if (pos.qty <= 1e-9) delete positions[s.symbol];
        continue;
      }

      // Buy path.
      let targetWeight = cfg.targetWeightPerBuy * sizeMult;
      if (targetWeight <= 0) continue;

      // Phase 5: cluster cap.
      if (flags.cluster && clusters.length) {
        const clip = sizeAgainstClusterCap({
          currentWeights: weights,
          proposedSymbol: s.symbol,
          proposedWeight: targetWeight,
          clusters,
          clusterCap: cfg.clusterCap,
        });
        targetWeight = clip.allowed_weight;
        if (targetWeight <= 1e-6) continue;
      }

      const notional = Math.min(cash, targetWeight * nav);
      if (notional <= 1) continue;
      const bps = perSideCostBps(flags.slicing);
      const priceWithCost = bar.close * (1 + bps / 10_000);
      const qty = notional / priceWithCost;
      cash -= qty * priceWithCost;
      const existing = positions[s.symbol];
      if (existing) {
        const totalQty = existing.qty + qty;
        existing.entryPrice = (existing.entryPrice * existing.qty + bar.close * qty) / totalQty;
        existing.qty = totalQty;
      } else {
        positions[s.symbol] = {
          qty, entryPrice: bar.close, entryDate: date,
          entryBar: bar, stop: null, prevClose: bar.close,
        };
      }
      trades.push({
        date, symbol: s.symbol, side: "buy", qty, price: bar.close, costBps: bps,
        reason: `signal buy (weight ${(targetWeight * 100).toFixed(1)}%)`,
      });
    }

    // Phase 6: tail-hedge overlay rebalance — priced against `hedgeSymbol`
    // and executed with the same no-leverage/no-borrow rules as the live
    // executor: buys are capped at cash * (1 - buffer), sells are capped at
    // the current held quantity, and both sides pay the standard fee/slippage
    // bps so Phase 6 contribution matches real-world hedge fills.
    if (flags.hedge && hedgeHasSeries) {
      const hedgePrice = hedgePriceOn(date);
      const postNav = (() => {
        let m = 0;
        for (const [sym, pos] of Object.entries(positions)) {
          const bar = bySym.get(sym)?.get(date);
          m += pos.qty * (bar?.close ?? pos.prevClose);
        }
        return cash + m + hedgeQty * hedgePrice;
      })();
      const dec = computeTailHedge({
        nav: postNav,
        cape: cfg.cape ?? null,
        regime: cfg.regime ?? null,
        currentHedgeNotional: hedgeQty * hedgePrice,
      });
      if (dec.action !== "hold" && hedgePrice > 0 && Math.abs(dec.deltaNotional) >= 1) {
        const bps = perSideCostBps(flags.slicing);
        if (dec.action === "buy") {
          // Same sizing rule as the paper/live executor (tail-hedge-sizing).
          const priceWithCost = hedgePrice * (1 + bps / 10_000);
          const sized = sizeHedgeBuy({
            deltaNotional: dec.deltaNotional,
            cash,
            price: hedgePrice,
            bufferPct: hedgeBufferPct,
            wholeShares: false, // backtests book fractional units, like paper
            effectivePrice: priceWithCost,
          });
          if (sized.ok) {
            const qty = sized.qty;
            cash -= qty * priceWithCost;
            hedgeQty += qty;
            trades.push({
              date, symbol: hedgeSymbol, side: "buy", qty, price: hedgePrice, costBps: bps,
              reason: `tail_hedge buy → target ${(dec.targetPctNav * 100).toFixed(2)}% NAV (${dec.reason})`,
            });
          }
        } else {
          // sell: unwind up to |delta|/price, capped at held qty (no shorting).
          const sized = sizeHedgeSell({
            deltaNotional: dec.deltaNotional,
            heldQty: hedgeQty,
            price: hedgePrice,
            wholeShares: false,
          });
          if (sized.ok) {
            const qty = sized.qty;
            const proceeds = qty * hedgePrice * (1 - bps / 10_000);
            cash += proceeds;
            hedgeQty -= qty;
            if (hedgeQty < 1e-9) hedgeQty = 0;
            trades.push({
              date, symbol: hedgeSymbol, side: "sell", qty, price: hedgePrice, costBps: bps,
              reason: `tail_hedge sell → target ${(dec.targetPctNav * 100).toFixed(2)}% NAV (${dec.reason})`,
            });
          }
        }

      }
      hedgePrevClose = hedgePrice;
    }

    // Roll prevClose for stop advance.
    for (const [sym, pos] of Object.entries(positions)) {
      const bar = bySym.get(sym)?.get(date);
      if (bar) pos.prevClose = bar.close;
    }

    // Snapshot equity.
    let endMv = 0;
    for (const [sym, pos] of Object.entries(positions)) {
      const bar = bySym.get(sym)?.get(date);
      endMv += pos.qty * (bar?.close ?? pos.prevClose);
    }
    equity.push({ date, equity: cash + endMv + hedgeMv(date) });
  }

  const metrics: RunMetrics = {
    cagr: computeCagr(equity),
    maxDrawdown: computeMaxDD(equity),
    winRate: computeWinRate(trades),
    totalReturn: equity.length ? equity[equity.length - 1].equity / cfg.initialCash - 1 : 0,
    trades: trades.length,
    finalEquity: equity.length ? equity[equity.length - 1].equity : cfg.initialCash,
  };

  return { metrics, equity, trades, flags };
}

// Leave-one-out attribution: contribution of phase X = full − run(full without X).
export function attributePhases(
  series: SymbolSeries[],
  signalFn: SignalFn,
  cfg: RunnerConfig = DEFAULT_CONFIG,
): BacktestOutput {
  const full = runPhaseBacktest(series, signalFn, ALL_PHASES_ON, cfg);
  const baseline = runPhaseBacktest(series, signalFn, ALL_PHASES_OFF, cfg);

  const phases: (keyof PhaseFlags)[] = ["earnings", "trailing", "slicing", "cluster", "hedge"];
  const contributions = {} as BacktestOutput["contributions"];
  for (const phase of phases) {
    const flags: PhaseFlags = { ...ALL_PHASES_ON, [phase]: false };
    const loo = runPhaseBacktest(series, signalFn, flags, cfg);
    contributions[phase] = {
      cagrDelta: full.metrics.cagr - loo.metrics.cagr,
      ddDelta: loo.metrics.maxDrawdown - full.metrics.maxDrawdown,
      winRateDelta: full.metrics.winRate - loo.metrics.winRate,
    };
  }

  return { full, baseline, contributions };
}
