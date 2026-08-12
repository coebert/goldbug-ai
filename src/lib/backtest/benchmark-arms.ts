// Benchmark arms for the order-batching replay.
//
// The A/B test answers "is batching cheaper than not batching?" — but both
// arms trade the same active strategy, so a reader still can't tell whether
// the strategy was worth trading at all. These baselines close that gap by
// replaying the SAME assets over the SAME bars with the SAME cost model:
//
//   buy_and_hold  — equal-weight the universe on the first usable bar, pay
//                   one ticket per name, then never trade again. This is the
//                   do-nothing alternative and the honest hurdle rate.
//   momentum_only — route every momentum signal the moment it fires, with no
//                   minimum-ticket floor and no batching window. This is the
//                   raw alpha, un-governed: it shows how much of the live
//                   result is signal and how much is cost control.
//
// Pure and deterministic: no I/O, no clock, no randomness.

import { runBacktest } from "../backtest-runner";
import type { SimDecision, SimState } from "../broker-simulator";
import { computeMaxDrawdown, computeSharpe, dailyReturns } from "../backtest-metrics";
import {
  runBatchingArm,
  type BatchingArmResult,
  type BatchingArmTrade,
  type OrderBatchingAbInput,
} from "./order-batching-ab";
import { estimateTradeCosts } from "../trade-viability-gate";
import {
  quoteExecutionImpact,
  DEFAULT_EXECUTION_IMPACT,
  type ExecutionImpactConfig,
} from "./execution-impact";

export type BenchmarkId = "buy_and_hold" | "momentum_only";

export type BenchmarkArmResult = Omit<BatchingArmResult, "arm"> & {
  id: BenchmarkId;
  label: string;
};

export type BenchmarkOutcome = "beats" | "lags" | "matches";

export type BenchmarkComparison = {
  id: BenchmarkId;
  label: string;
  /** Positive = the live (batched) strategy returned more. Percentage points. */
  returnDeltaPct: number;
  /** Positive = the live strategy drew down MORE (worse). Percentage points. */
  drawdownDeltaPct: number;
  /** Positive = the live strategy has the better risk-adjusted return. */
  sharpeDelta: number;
  /** Positive = the live strategy paid MORE in costs, bps of starting equity. */
  costDeltaBps: number;
  outcome: BenchmarkOutcome;
  note: string;
};

export type BenchmarkResult = {
  arms: BenchmarkArmResult[];
  comparisons: BenchmarkComparison[];
  summary: string;
};

/** Return delta (pp) inside which the strategy is called a tie with a baseline. */
export const DEFAULT_BENCHMARK_TOLERANCE_PCT = 1;

function defaultCost(o: {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  assetClass?: string | null;
}): number {
  const c = estimateTradeCosts({
    symbol: o.symbol,
    side: o.side,
    quantity: o.quantity,
    price: o.price,
    assetClass: o.assetClass ?? null,
  });
  return Number.isFinite(c.oneWayCost) ? c.oneWayCost : 0;
}

function assetClassOf(input: OrderBatchingAbInput, symbol: string): string | null {
  for (const s of input.signals) {
    if (s.symbol === symbol && s.assetClass != null) return s.assetClass;
  }
  return null;
}

/**
 * Equal-weight the universe on the first bar that prices it and hold to the end.
 */
export async function runBuyAndHoldArm(
  input: OrderBatchingAbInput,
): Promise<BenchmarkArmResult> {
  const costFor = input.costModel ?? defaultCost;
  const startingCash = Math.max(0, Number(input.startingCash) || 0);
  const first = input.bars[0];
  const symbols = first ? Object.keys(first.closes).filter((s) => Number(first.closes[s]) > 0) : [];
  const perName = symbols.length > 0 ? startingCash / symbols.length : 0;

  const trades: Array<BatchingArmTrade & { id: string }> = [];

  const execConfig: ExecutionImpactConfig = {
    ...DEFAULT_EXECUTION_IMPACT,
    ...(input.execution ?? {}),
  };

  const strategy = async (ctx: {
    date: string;
    barIndex: number;
    closes: Record<string, number>;
    history: Record<string, number[]>;
  }): Promise<SimDecision[]> => {
    if (ctx.barIndex !== 0) return [];
    const decisions: SimDecision[] = [];
    symbols.forEach((symbol, i) => {
      const price = Number(ctx.closes[symbol]);
      if (!Number.isFinite(price) || price <= 0) return;
      // Leave a slice of the budget for the ticket cost so the simulator's
      // no-borrow rule doesn't reject the fill outright.
      const quantity = Math.floor((perName * 0.99) / price);
      if (quantity <= 0) return;
      const assetClass = assetClassOf(input, symbol);
      const impact = quoteExecutionImpact({
        symbol,
        quantity,
        price,
        assetClass,
        history: ctx.history?.[symbol],
        config: execConfig,
      });
      const cost =
        costFor({ symbol, side: "buy", quantity, price, assetClass }) + impact.slippageBase;
      const id = `bh-${ctx.date}-${i}`;
      trades.push({
        id,
        date: ctx.date,
        symbol,
        side: "buy",
        quantity,
        price,
        notional: quantity * price,
        cost,
        slippageBase: impact.slippageBase,
        slippageBps: impact.slippageBps,
        participation: impact.participation,
        parkedQuantity: 0,
        waitedHours: 0,
      });
      decisions.push({ id, symbol, side: "BUY", quantity, price, fee: cost });
    });
    return decisions;
  };

  const initial: SimState = { cash: startingCash, holdings: [] };
  const result = await runBacktest(initial, input.bars, strategy as never);

  const rejected = new Set(result.rejections.map((r) => r.decisionId));
  const filled = trades.filter((t) => !rejected.has(t.id)).map(({ id: _id, ...rest }) => rest);

  const totalCostBase = filled.reduce((a, t) => a + t.cost, 0);
  const totalSlippageBase = filled.reduce((a, t) => a + t.slippageBase, 0);
  const turnoverBase = filled.reduce((a, t) => a + t.notional, 0);
  const avgParticipation =
    turnoverBase > 0
      ? filled.reduce((a, t) => a + t.participation * t.notional, 0) / turnoverBase
      : 0;
  const finalValue = result.equityCurve.at(-1)?.totalValue ?? startingCash;
  const points = result.equityCurve.map((p) => ({
    snapshot_date: p.date,
    total_value: p.totalValue,
  }));

  return {
    id: "buy_and_hold",
    label: "Buy & hold",
    tickets: filled.length,
    trades: filled,
    totalCostBase,
    totalSlippageBase,
    slippageBpsOfEquity: startingCash > 0 ? (totalSlippageBase / startingCash) * 10_000 : 0,
    avgParticipation,
    costBpsOfTurnover: turnoverBase > 0 ? (totalCostBase / turnoverBase) * 10_000 : 0,
    costBpsOfEquity: startingCash > 0 ? (totalCostBase / startingCash) * 10_000 : 0,
    turnoverBase,
    signalsSkipped: 0,
    parkedLost: 0,
    ticketsCapped: 0,
    startingValue: startingCash,
    finalValue,
    returnPct: startingCash > 0 ? ((finalValue - startingCash) / startingCash) * 100 : 0,
    maxDrawdownPct: Math.abs(computeMaxDrawdown(points).pct),
    sharpe: computeSharpe(dailyReturns(points)),
    equityCurve: result.equityCurve.map((p) => ({ date: p.date, totalValue: p.totalValue })),
  };
}

/**
 * Route every signal immediately: no minimum-ticket floor, no batching window.
 */
export async function runMomentumOnlyArm(
  input: OrderBatchingAbInput,
): Promise<BenchmarkArmResult> {
  const arm = await runBatchingArm("unbatched", { ...input, minTicketBase: 0 });
  const { arm: _arm, ...rest } = arm;
  return { ...rest, id: "momentum_only", label: "Momentum only (no cost control)" };
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

function compare(
  live: { returnPct: number; maxDrawdownPct: number; sharpe: number; costBpsOfEquity: number },
  bench: BenchmarkArmResult,
  tolerancePct: number,
): BenchmarkComparison {
  const returnDeltaPct = live.returnPct - bench.returnPct;
  const drawdownDeltaPct = live.maxDrawdownPct - bench.maxDrawdownPct;
  const sharpeDelta = (live.sharpe ?? 0) - (bench.sharpe ?? 0);
  const costDeltaBps = live.costBpsOfEquity - bench.costBpsOfEquity;

  const outcome: BenchmarkOutcome =
    returnDeltaPct > tolerancePct ? "beats" : returnDeltaPct < -tolerancePct ? "lags" : "matches";

  const note =
    outcome === "beats"
      ? `Strategy is ${fmt(returnDeltaPct, 2)}pp ahead of ${bench.label.toLowerCase()} with ${
          drawdownDeltaPct <= 0 ? `${fmt(-drawdownDeltaPct, 2)}pp less` : `${fmt(drawdownDeltaPct, 2)}pp more`
        } drawdown.`
      : outcome === "lags"
        ? `Strategy trails ${bench.label.toLowerCase()} by ${fmt(-returnDeltaPct, 2)}pp while paying ${signedBps(costDeltaBps)} in costs.`
        : `Strategy matches ${bench.label.toLowerCase()} within ${fmt(tolerancePct, 1)}pp; the difference is cost and timing, not signal.`;

  return { id: bench.id, label: bench.label, returnDeltaPct, drawdownDeltaPct, sharpeDelta, costDeltaBps, outcome, note };
}

function signedBps(v: number): string {
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}bps`;
}

/**
 * Run both baselines over the same assets/period and score the live (batched)
 * arm against them.
 */
export async function runBenchmarkArms(
  input: OrderBatchingAbInput,
  live: { returnPct: number; maxDrawdownPct: number; sharpe: number; costBpsOfEquity: number },
  options: { tolerancePct?: number } = {},
): Promise<BenchmarkResult> {
  const tolerance = options.tolerancePct ?? DEFAULT_BENCHMARK_TOLERANCE_PCT;
  const [buyHold, momentum] = await Promise.all([
    runBuyAndHoldArm(input),
    runMomentumOnlyArm(input),
  ]);
  const arms = [buyHold, momentum];
  const comparisons = arms.map((a) => compare(live, a, tolerance));

  const beaten = comparisons.filter((c) => c.outcome === "beats").length;
  const lagged = comparisons.filter((c) => c.outcome === "lags").length;
  const summary =
    beaten === comparisons.length
      ? `The live strategy beat both baselines: ${comparisons.map((c) => `${c.label} by ${fmt(c.returnDeltaPct, 2)}pp`).join(", ")}.`
      : lagged === comparisons.length
        ? `The live strategy lost to both baselines — ${comparisons.map((c) => `${c.label} by ${fmt(-c.returnDeltaPct, 2)}pp`).join(", ")}. On this sample the trading added cost, not return.`
        : comparisons.map((c) => c.note).join(" ");

  return { arms, comparisons, summary };
}
