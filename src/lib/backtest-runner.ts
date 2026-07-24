// Backtesting runner.
//
// Replays historical market data through a user-supplied decision
// strategy, one step at a time, and produces a full cash + holdings
// snapshot after EVERY decision step by delegating ledger arithmetic
// to the pure `broker-simulator`. The runner itself is a pure module
// — no I/O, no time, no randomness — so it is fully deterministic and
// unit-testable.
//
// Design:
//   - Caller provides an array of `BacktestBar` rows keyed by date,
//     each carrying a per-symbol close price. The runner iterates the
//     bars in order, calls the caller's `strategy` with the current
//     ledger state + a rolling price history, and expects zero or
//     more `SimDecision`s back.
//   - Every decision is executed at the bar's close price (unless
//     the strategy overrides `price`) via `simulateBrokerExecution`,
//     which enforces the no-borrow / no-leverage invariants. The
//     resulting per-step snapshots are stamped with the bar's date
//     and appended to a chronologically-ordered list.
//   - A "step" is a single decision. Days with no decisions still
//     produce a mark-to-market equity point via `equityCurve`, so
//     callers can chart continuous PnL without needing to re-derive it.
//
// This module owns strategy replay + snapshotting only. Metric
// aggregation (Sharpe, drawdown, benchmark comparison) belongs to the
// existing long-horizon module and can consume the outputs here.

import {
  simulateBrokerExecution,
  type SimDecision,
  type SimHolding,
  type SimSnapshot,
  type SimRejection,
  type SimState,
  type SimulateOptions,
} from "./broker-simulator";

export type BacktestBar = {
  /** ISO date (YYYY-MM-DD). Bars must be strictly increasing. */
  date: string;
  /** Close price per symbol for this bar. */
  closes: Record<string, number>;
};

export type BacktestStrategyContext = {
  /** ISO date of the current bar. */
  date: string;
  /** 0-based bar index. */
  barIndex: number;
  /** Current ledger state BEFORE any decisions on this bar. */
  state: SimState;
  /** Current-bar close prices. */
  closes: Record<string, number>;
  /**
   * Rolling per-symbol close history up to and including today,
   * oldest → newest. Only symbols seen in the bar stream so far.
   */
  history: Record<string, number[]>;
};

export type BacktestStrategy = (
  ctx: BacktestStrategyContext,
) => SimDecision[] | Promise<SimDecision[]>;

export type BacktestOptions = {
  simulator?: SimulateOptions;
  /**
   * Optional fixed fee applied to every strategy decision that does
   * not set its own `fee`. Defaults to 0.
   */
  defaultFee?: number;
};

/** Snapshot produced after one strategy decision on a given bar. */
export type BacktestStepSnapshot = SimSnapshot & {
  date: string;
  barIndex: number;
};

/** Rejection produced by the broker-simulator for a decision. */
export type BacktestStepRejection = SimRejection & {
  date: string;
  barIndex: number;
};

/** Daily mark-to-market equity point (one per bar, even on no-trade days). */
export type BacktestEquityPoint = {
  date: string;
  barIndex: number;
  cash: number;
  holdingsValue: number;
  totalValue: number;
  /** Number of decision steps executed on this bar (post-simulator). */
  steps: number;
};

export type BacktestResult = {
  finalState: SimState;
  snapshots: BacktestStepSnapshot[];
  rejections: BacktestStepRejection[];
  equityCurve: BacktestEquityPoint[];
};

function cloneHoldings(hs: SimHolding[]): SimHolding[] {
  return hs.map((h) => ({ ...h }));
}

function markToMarket(
  holdings: SimHolding[],
  closes: Record<string, number>,
): number {
  let sum = 0;
  for (const h of holdings) {
    const p = closes[h.symbol];
    const safe = Number.isFinite(p) && (p as number) > 0 ? (p as number) : h.avgCost;
    sum += h.quantity * (Number.isFinite(safe) && safe > 0 ? safe : 0);
  }
  return sum;
}

function assertBarsChronological(bars: BacktestBar[]): void {
  for (let i = 1; i < bars.length; i++) {
    if (!(bars[i].date > bars[i - 1].date)) {
      throw new Error(
        `backtest bars must be strictly chronological (bar ${i} "${bars[i].date}" <= bar ${i - 1} "${bars[i - 1].date}")`,
      );
    }
  }
}

/**
 * Replay `bars` through `strategy`, producing cash + holdings
 * snapshots after every decision step.
 */
export async function runBacktest(
  initial: SimState,
  bars: BacktestBar[],
  strategy: BacktestStrategy,
  options: BacktestOptions = {},
): Promise<BacktestResult> {
  assertBarsChronological(bars);
  const defaultFee = Number.isFinite(options.defaultFee) && (options.defaultFee ?? 0) >= 0
    ? (options.defaultFee as number)
    : 0;

  let state: SimState = {
    cash: initial.cash,
    holdings: cloneHoldings(initial.holdings),
  };

  const snapshots: BacktestStepSnapshot[] = [];
  const rejections: BacktestStepRejection[] = [];
  const equityCurve: BacktestEquityPoint[] = [];
  const history: Record<string, number[]> = {};

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    // Extend rolling history first so the strategy sees today's close.
    for (const [sym, px] of Object.entries(bar.closes)) {
      if (!Number.isFinite(px)) continue;
      (history[sym] ??= []).push(px);
    }

    const decisions = await strategy({
      date: bar.date,
      barIndex: i,
      state: { cash: state.cash, holdings: cloneHoldings(state.holdings) },
      closes: bar.closes,
      history,
    });

    // Default fee + fill price from today's close where the strategy
    // didn't override it. This is what makes "close-price execution"
    // the runner's contract, matching how bar-driven backtests are
    // normally scored.
    const priced: SimDecision[] = decisions.map((d) => ({
      ...d,
      price: Number.isFinite(d.price) ? d.price : bar.closes[d.symbol],
      fee: d.fee ?? defaultFee,
    }));

    const sim = simulateBrokerExecution(state, priced, {
      ...options.simulator,
      markPrices: { ...(options.simulator?.markPrices ?? {}), ...bar.closes },
    });

    for (const s of sim.snapshots) {
      snapshots.push({ ...s, date: bar.date, barIndex: i });
    }
    for (const r of sim.rejections) {
      rejections.push({ ...r, date: bar.date, barIndex: i });
    }

    state = {
      cash: sim.finalState.cash,
      holdings: cloneHoldings(sim.finalState.holdings),
    };

    const holdingsValue = markToMarket(state.holdings, bar.closes);
    equityCurve.push({
      date: bar.date,
      barIndex: i,
      cash: state.cash,
      holdingsValue,
      totalValue: state.cash + holdingsValue,
      steps: sim.snapshots.length,
    });
  }

  return { finalState: state, snapshots, rejections, equityCurve };
}
