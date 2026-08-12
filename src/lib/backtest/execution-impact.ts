// Market-impact and slippage model for the batching replay.
//
// The A/B test originally priced every ticket with commission + stamp + a
// flat half-spread. That flatters batching: parking three small buys and
// releasing them as one big ticket pays the commission floor once, and under
// a size-blind cost model the bigger ticket costs the same per pound as the
// small ones did. In a real book it does not — a larger order walks further
// up the queue and pays market impact that grows with participation.
//
// This module supplies that missing size-dependent term so the replay can
// answer the harder question: does batching still save money once the saved
// commission is netted against the impact the larger ticket creates?
//
// Model (per side, bps of notional), delegating to the live
// `estimateSpreadSlippage` so the backtest and the production sizing path
// share one set of constants:
//
//   impact  = k * sigma * sqrt(notional / ADV)   (square-root law)
//   latency = fixed venue/queue toll
//   urgency = crossing premium for aggressive orders
//
// The half-spread term is deliberately EXCLUDED here: the replay's cost model
// (`estimateTradeCosts`) already charges it, and charging it twice would make
// every arm look worse without changing their difference.
//
// Volatility comes from the bar history the runner already carries, so no
// extra data source is needed. ADV is optional: when the price cache has
// volume the caller passes a real 20-day traded value, otherwise a
// conservative default keeps participation honest rather than zero.
//
// Pure and deterministic.

import {
  estimateSpreadSlippage,
  type OrderUrgency,
  type SpreadSlippageTuning,
} from "../spread-slippage";
import type { AssetClass } from "../universe.server";

export type ExecutionImpactConfig = {
  /** Master switch. When false the replay behaves exactly as before. */
  enabled: boolean;
  urgency: OrderUrgency;
  /**
   * 20-day average traded value per symbol, in base currency. Missing symbols
   * fall back to `defaultAdvBase`.
   */
  advBySymbol?: Record<string, number>;
  /** ADV assumed when a symbol has no volume history. */
  defaultAdvBase: number;
  /** Overrides for the shared slippage tuning (impact_coeff, caps, ...). */
  overrides?: Partial<SpreadSlippageTuning>;
};

export const DEFAULT_EXECUTION_IMPACT: ExecutionImpactConfig = {
  enabled: true,
  urgency: "normal",
  // £2m/day: a mid-cap LSE name. Small enough that a £1k ticket is ~0bps of
  // impact and a £50k ticket is felt, which is the regime this app trades in.
  defaultAdvBase: 2_000_000,
};

export type ExecutionImpactQuote = {
  /** Size-dependent impact, bps of notional. */
  impactBps: number;
  /** Fixed latency/queue toll, bps. */
  latencyBps: number;
  /** Urgency premium (negative for passive), bps. */
  urgencyBps: number;
  /** impact + latency + urgency, bps. Excludes the half-spread. */
  slippageBps: number;
  /** slippageBps applied to the ticket notional, base currency. */
  slippageBase: number;
  /** notional / ADV for this ticket. */
  participation: number;
  /** Volatility proxy fed to the impact model, as a fraction of price. */
  atrPct: number;
};

/**
 * Volatility proxy from a rolling close series: mean absolute daily return
 * over the lookback, which tracks 14d ATR% closely enough for sizing-scale
 * impact and needs no high/low data.
 */
export function realizedAtrPct(history: readonly number[], lookback = 14): number {
  if (!history || history.length < 2) return 0;
  const start = Math.max(1, history.length - lookback);
  let sum = 0;
  let n = 0;
  for (let i = start; i < history.length; i++) {
    const prev = Number(history[i - 1]);
    const cur = Number(history[i]);
    if (!(prev > 0) || !Number.isFinite(cur)) continue;
    sum += Math.abs(cur - prev) / prev;
    n += 1;
  }
  return n > 0 ? sum / n : 0;
}

const ZERO: ExecutionImpactQuote = {
  impactBps: 0,
  latencyBps: 0,
  urgencyBps: 0,
  slippageBps: 0,
  slippageBase: 0,
  participation: 0,
  atrPct: 0,
};

/** Price the size-dependent execution cost of a single ticket. */
export function quoteExecutionImpact(args: {
  symbol: string;
  quantity: number;
  price: number;
  assetClass?: string | null;
  currency?: string | null;
  /** Rolling close history for the symbol, oldest → newest. */
  history?: readonly number[];
  config?: Partial<ExecutionImpactConfig>;
}): ExecutionImpactQuote {
  const config = { ...DEFAULT_EXECUTION_IMPACT, ...(args.config ?? {}) };
  const notional = Math.max(0, (Number(args.quantity) || 0) * (Number(args.price) || 0));
  if (!config.enabled || notional <= 0) return ZERO;

  const atrPct = realizedAtrPct(args.history ?? []);
  const adv = Math.max(
    0,
    Number(args.advBySymbolLookup?.(args.symbol) ?? config.advBySymbol?.[args.symbol]) ||
      config.defaultAdvBase ||
      0,
  );

  const b = estimateSpreadSlippage({
    assetClass: (args.assetClass as AssetClass | null) ?? null,
    currency: args.currency ?? null,
    atrPct,
    notional,
    adv20d: adv,
    urgency: config.urgency,
    overrides: config.overrides,
  });

  // Half-spread is charged by the commission/stamp model, so drop it here.
  const slippageBps = Math.max(0, b.impactBps + b.latencyBps + b.urgencyBps);

  return {
    impactBps: b.impactBps,
    latencyBps: b.latencyBps,
    urgencyBps: b.urgencyBps,
    slippageBps,
    slippageBase: (notional * slippageBps) / 10_000,
    participation: b.participation,
    atrPct,
  };
}

/**
 * Average traded value per symbol from cached bars. Returns base-currency
 * notional per day, which is what the participation ratio needs.
 */
export function advFromBars(
  rows: ReadonlyArray<{ symbol: string; close: number; volume?: number | null }>,
  lookback = 20,
): Record<string, number> {
  const byS = new Map<string, number[]>();
  for (const r of rows) {
    const v = Number(r.volume);
    const c = Number(r.close);
    if (!(v > 0) || !(c > 0)) continue;
    (byS.get(r.symbol) ?? byS.set(r.symbol, []).get(r.symbol)!).push(v * c);
  }
  const out: Record<string, number> = {};
  for (const [sym, series] of byS) {
    const tail = series.slice(-Math.max(1, lookback));
    out[sym] = tail.reduce((a, b) => a + b, 0) / tail.length;
  }
  return out;
}
