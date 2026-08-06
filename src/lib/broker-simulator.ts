// Broker execution simulator with strict no-borrow / no-leverage rules.
//
// This is a PURE function: given a starting cash + holdings state, a
// list of decisions, and a per-symbol price map, it returns the final
// state plus a snapshot after every decision step. Deterministic and
// side-effect free so it can be unit-tested exhaustively and reused by
// backtests, previews, and the paper-trading engine.
//
// Invariants enforced (any violation truncates or rejects the step,
// never breaks these):
//   1. NO BORROWING — cash is never allowed to go below 0. A BUY that
//      would overspend is either truncated to the affordable quantity
//      or rejected outright (configurable). Fees/commissions count.
//   2. NO LEVERAGE  — holdings.quantity is never allowed to go below
//      0. A SELL beyond the current position is truncated to the held
//      quantity (no shorting).
//   3. CONSISTENT SNAPSHOTS — after every applied step, the emitted
//      snapshot satisfies:
//        total_value === cash + Σ (holding.quantity * mark_price)
//      to full float precision (no drift, no rounding gaps).
//   4. DETERMINISM — same inputs ⇒ byte-identical outputs, including
//      the ordering of the snapshot array and rejection reasons.
//   5. NON-NEGATIVE, FINITE INPUTS — non-finite prices, quantities,
//      or fees reject the step with a typed reason. Zero-price marks
//      contribute 0 to holdings_value but do not corrupt totals.
//
// The simulator is intentionally naive about market microstructure —
// slippage, partial fills, and queue position live in
// execution-realism / execution-slicer. This module owns the ledger
// arithmetic and its guarantees.

import { effectiveMaxParticipation } from "./microstructure/algo-regime-guard";
import { computeCommission, type CommissionModel } from "./commission-model";
import { estimateSpreadSlippage } from "./spread-slippage";
import type { LiquidityFrictions } from "./liquidity-profile";
import type { AssetClass } from "./universe.server";

export type Side = "BUY" | "SELL";

export type SimDecision = {
  /** Stable id used to correlate the snapshot back to the decision. */
  id: string;
  symbol: string;
  side: Side;
  /** Requested quantity, in shares/units. Must be finite and > 0. */
  quantity: number;
  /** Execution price per unit. Must be finite and >= 0. */
  price: number;
  /** Optional fixed fee (currency units, >= 0). */
  fee?: number;
  /**
   * Optional per-decision override of the available market volume
   * (shares/units) that can fill this order. Takes precedence over
   * `options.liquidity.availableVolume[symbol]`. When present alongside
   * `options.liquidity.maxParticipationRate`, the fill is capped at
   * `availableVolume * maxParticipationRate` (participation applies to
   * ADV-like volumes, not to a size someone else has already sized down).
   */
  availableVolume?: number;
  /**
   * Optional per-decision rolling window of recent bar volumes. Used
   * only when `availableVolume` is not set. The engine reduces this
   * series to a single volume figure via the liquidity model's
   * aggregator (default `mean`) and treats the result exactly as if it
   * had been passed as `availableVolume`. Empty / all-invalid arrays
   * fall back to `options.liquidity` sources.
   */
  volumeHistory?: number[];

};

export type SimHolding = {
  symbol: string;
  quantity: number;
  /**
   * Average cost per unit. Weighted-averaged across BUYs; unchanged by
   * SELLs (realized PnL is reported per step, not folded back in).
   */
  avgCost: number;
};

export type SimState = {
  cash: number;
  holdings: SimHolding[];
};

export type SimSnapshot = {
  /** Sequence number, starting at 1 for the first applied step. */
  step: number;
  decisionId: string;
  /** Traded symbol — mirrored from the source decision for easy grouping. */
  symbol: string;
  /** Side of the executed decision. */
  side: Side;
  cash: number;
  holdings: SimHolding[];
  /** Σ (quantity * mark_price) at the moment this snapshot was taken. */
  holdingsValue: number;
  /** cash + holdingsValue — always internally consistent. */
  totalValue: number;
  /** Realized PnL for a SELL step, 0 otherwise. */
  realizedPnl: number;

  fillQuantity: number;
  fillPrice: number;
  fee: number;
  /** Originally requested quantity (before liquidity/cash truncation). */
  requestedQuantity: number;
  /** True when fillQuantity < requestedQuantity for any reason. */
  partial: boolean;
  /**
   * Highest-priority reason the fill was truncated below `requestedQuantity`,
   * or `null` for a full fill. Priority (highest first):
   *   "liquidity" > "cash" > "position".
   */
  truncationReason: "liquidity" | "cash" | "position" | null;
  /**
   * When set, this snapshot is a time-sliced continuation of the parent
   * `sliceOf` decision. `sliceIndex` is 0 for the parent snapshot and
   * 1..N for each residual re-attempt. Present only when the caller
   * enables `timeSliceUnfilled`; omitted for one-shot fills.
   */
  sliceOf?: string;
  sliceIndex?: number;
  // -------- execution-quality diagnostics -----------------------------------
  /**
   * The quoted decision price fed into the engine (`decision.price`) —
   * pinned on the snapshot so downstream consumers don't have to join
   * back against the input array to compute slippage or debug fills.
   */
  expectedPrice: number;
  /**
   * Signed slippage of the realized fill vs the quoted expected price,
   * expressed in basis points and always oriented so positive = adverse:
   *   BUY:  (fillPrice - expectedPrice) / expectedPrice * 1e4
   *   SELL: (expectedPrice - fillPrice) / expectedPrice * 1e4
   * `0` when the expected price is 0 or the step didn't fill.
   */
  slippageBps: number;
  /**
   * Fraction of the raw (pre-participation-rate) liquidity cap that
   * this fill consumed, in `[0, 1]`. `null` when the symbol was
   * unconstrained (no volume estimate available), so callers can
   * distinguish "we consumed 100% of a small book" from "there was no
   * book to measure against".
   */
  participationRate: number | null;
  /**
   * `slippageBps` normalized by `participationRate` — a rough
   * "cost per unit of liquidity consumed" that lets you compare fills
   * across very different order sizes and books. `null` whenever
   * `participationRate` is `null` or `0`.
   */
  liquidityAdjustedSlippageBps: number | null;
};




export type SimRejection = {
  step: number;
  decisionId: string;
  symbol: string;
  side: Side;
  reason:
    | "invalid_quantity"
    | "invalid_price"
    | "invalid_fee"
    | "no_position_to_sell"
    | "insufficient_cash"
    | "would_borrow"
    | "would_short"
    | "no_liquidity"
    | "algo_regime_block";
  requested: { quantity: number; price: number; fee: number };
};

/**
 * Realistic trading frictions applied to every fill when provided.
 * All fields optional; omitted values default to 0 (frictionless).
 *
 *  - commissionBps      per-fill commission as basis points of notional
 *                       (5 = 0.05%). Combined with `minCommission` via max().
 *  - minCommission      minimum commission floor per fill (currency units).
 *  - buyTaxBps          buy-side transaction tax (e.g. UK stamp duty 50 bps).
 *                       Not applied on SELLs.
 *  - slippageBps        fixed adverse move applied to the quoted price:
 *                       BUY fills at quote*(1+bps/1e4), SELL at quote*(1-bps/1e4).
 *  - impactPerUnit      additional adverse slip that scales linearly with
 *                       filled quantity — proxies book-depth impact for
 *                       larger orders. Same sign convention as slippageBps.
 *
 * The invariants (no borrow, no leverage, snapshot consistency, no
 * negative cash) hold regardless of the friction values chosen.
 */
export type Frictions = {
  commissionBps?: number;
  minCommission?: number;
  buyTaxBps?: number;
  slippageBps?: number;
  impactPerUnit?: number;
  /**
   * Optional scaling commission model. When present it REPLACES the flat
   * `commissionBps`/`minCommission` pair: the fee is computed per fill from
   * the tiered venue schedule (bps that steps down with notional, per-share
   * component, per-ticket floor and cap) plus the monthly-volume discount.
   * Buy-side tax and per-decision `fee` still apply on top.
   */
  commission?: {
    model?: CommissionModel;
    /** Trailing 30-day traded notional used for the discount ladder. */
    monthlyVolume?: number;
    /** Per-symbol trade currency (defaults to inference from the ticker). */
    currencyBySymbol?: Record<string, string>;
    /** Per-symbol asset class, enabling class overrides (e.g. crypto). */
    assetClassBySymbol?: Record<string, AssetClass>;
  };
};

export type SimulateOptions = {
  /**
   * If a BUY exceeds available cash, truncate the quantity to what
   * cash allows instead of rejecting (default: true). Fees are always
   * subtracted first — if the fee alone exceeds cash, the step is
   * rejected as "insufficient_cash".
   */
  truncateBuysToCash?: boolean;
  /**
   * If a SELL exceeds the held quantity, truncate to the held amount
   * (default: true). Otherwise the step is rejected as
   * "no_position_to_sell" (when position == 0) or "would_short".
   */
  truncateSellsToPosition?: boolean;
  /**
   * Optional mark-to-market prices used when emitting each snapshot's
   * holdings_value. Falls back to the fill price for the traded
   * symbol and to `avgCost` for other holdings when a symbol is not
   * present. Symbols in this map DO NOT trigger any trades.
   */
  markPrices?: Record<string, number>;
  /**
   * Optional transaction-cost & slippage model. When omitted, the
   * engine runs frictionless (byte-identical to prior behaviour) so
   * existing callers/tests are unaffected.
   */
  frictions?: Frictions;
  /**
   * Optional liquidity / market-volume constraint. Applied BEFORE the
   * cash and position truncation checks — fills are first capped at
   * whatever the market can actually absorb, then further truncated if
   * cash (BUY) or held position (SELL) is insufficient.
   *
   *  - availableVolume[symbol]    hard cap on units filled for that symbol
   *                               this step. Per-decision `availableVolume`
   *                               overrides this on a given decision.
   *  - maxParticipationRate       fraction in (0,1] limiting the fill to
   *                               that share of the available volume
   *                               (proxies "don't be more than X% of ADV").
   *                               Defaults to 1 (whole book fillable).
   *  - minFillQuantity            if the post-cap fill is below this floor
   *                               the step is rejected as "no_liquidity"
   *                               instead of producing a dust partial.
   *                               Defaults to 0 (any positive fill accepted).
   *
   * When neither map nor per-decision `availableVolume` is set, the
   * symbol is treated as unconstrained (byte-identical to prior behaviour).
   */
  liquidity?: {
    availableVolume?: Record<string, number>;
    maxParticipationRate?: number;
    minFillQuantity?: number;
    /**
     * Per-symbol rolling window of recent bar volumes (oldest → newest,
     * or any order — only the trailing `rollingWindow` entries and their
     * aggregate matter). When a decision has neither its own
     * `availableVolume` nor `volumeHistory`, and no
     * `availableVolume[symbol]` entry exists, the engine derives the
     * per-step cap from these bars using `volumeAggregator`
     * (default `mean`). Empty / all-invalid arrays are treated as
     * unconstrained.
     */
    volumeHistory?: Record<string, number[]>;
    /**
     * Number of trailing bars to include when reducing `volumeHistory`
     * (either per-symbol or per-decision) to a single figure. `0`,
     * negative, or omitted means "use the entire supplied history".
     */
    rollingWindow?: number;
    /**
     * How to reduce the trailing window to a single volume estimate.
     *  - "mean"   arithmetic mean (default; classic N-bar ADV proxy).
     *  - "median" order-statistic median (robust to outlier bars).
     *  - "min"    conservative worst-case bar in the window.
     */
    volumeAggregator?: "mean" | "median" | "min";
  };

  /**
   * When true, any decision that only partially fills because of a
   * `liquidity` truncation has its residual quantity automatically
   * re-queued as a follow-up decision, up to
   * `timeSliceMaxAttempts` extra attempts (default 5). Each attempt
   * gets a FRESH per-decision liquidity cap — mirroring "the next bar
   * of ADV becomes available" — and produces its own snapshot linked
   * to the original decision via `sliceOf` + `sliceIndex`. Slices
   * respect the same cash / position / min-fill rules as any other
   * decision, and stop early once the residual is fully filled or a
   * follow-up gets rejected. Off by default: existing callers keep
   * one-shot semantics.
   */
  timeSliceUnfilled?: boolean;
  timeSliceMaxAttempts?: number;

  /**
   * Phase B — adaptive execution guardrail. When set, the snapshot's
   * `multipliers.maxParticipation` is folded into `liquidity` as the
   * stricter of {caller cap, regime cap}, and if `blockNewBuys` is true
   * every BUY decision is rejected up-front with reason
   * `algo_regime_block` (SELLs / protective exits are never blocked).
   * Omit for byte-identical legacy behaviour.
   */
  algoRegime?: import("./microstructure/algo-regime").AlgoRegimeSnapshot | null;
};

/**
 * Aggregate execution-quality diagnostics. Cheap to derive from the
 * per-snapshot data but pre-computed here so downstream evaluators
 * (backtests, live executor, tests) don't have to re-implement the
 * weighting every time. All slippage figures are notional-weighted
 * (fillQuantity * expectedPrice) so a tiny partial fill can't skew
 * the summary against a large well-executed one.
 */
export type ExecutionQualityReport = {
  /** Number of decisions submitted (before slicing / rejection). */
  decisionCount: number;
  /** Sum of every snapshot's `requestedQuantity` (excludes slices). */
  totalRequested: number;
  /** Sum of every snapshot's `fillQuantity` (includes slice fills). */
  totalFilled: number;
  /** `totalFilled / totalRequested`, clamped to `[0, 1]`. `1` when no requests. */
  fillRatio: number;
  fullyFilledCount: number;
  partialFillCount: number;
  rejectionCount: number;
  /** Count of rejections keyed by `SimRejection.reason`. */
  rejectionsByReason: Record<SimRejection["reason"], number>;
  /**
   * Notional-weighted average signed slippage in bps across every
   * snapshot with a positive fill. Positive = adverse to the trader.
   */
  weightedAvgSlippageBps: number;
  /**
   * Notional-weighted average of `liquidityAdjustedSlippageBps`
   * across snapshots where it was defined. `null` when nothing in
   * the run had a measurable liquidity constraint.
   */
  weightedAvgLiquidityAdjustedSlippageBps: number | null;
  /**
   * Simple mean of `participationRate` across snapshots where it
   * was defined. `null` when no fill touched a constrained book.
   */
  avgParticipationRate: number | null;
  /**
   * Per-symbol drill-down using the same weighting rules as the top
   * level. Keys are the raw `symbol` strings from the decisions.
   */
  bySymbol: Record<string, {
    requested: number;
    filled: number;
    fillRatio: number;
    weightedAvgSlippageBps: number;
    weightedAvgLiquidityAdjustedSlippageBps: number | null;
    avgParticipationRate: number | null;
    fillCount: number;
  }>;
};

export type SimulateResult = {
  finalState: SimState;
  snapshots: SimSnapshot[];
  rejections: SimRejection[];
  /** Aggregate diagnostics — see `ExecutionQualityReport`. */
  executionQuality: ExecutionQualityReport;
};


// ---------------------------------------------------------------------------

function isFiniteNonNeg(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

/**
 * Effective (post-slippage) execution price for a given quoted price,
 * side, and fill quantity. BUYs pay up, SELLs receive down. Impact is
 * linear in qty. Returned price is clamped >= 0.
 */
function effectiveFillPrice(
  quote: number,
  qty: number,
  side: Side,
  f: Frictions | undefined,
): number {
  if (!f) return quote;
  const slipFrac = (f.slippageBps ?? 0) / 10_000;
  const impact = (f.impactPerUnit ?? 0) * qty;
  if (side === "BUY") return quote * (1 + slipFrac) + impact;
  return Math.max(0, quote * (1 - slipFrac) - impact);
}

/** Context needed by the scaling commission model. */
type FeeContext = { symbol: string; quantity: number };

/**
 * Total fee for a fill: baseFee (per-decision override) + commission +
 * buy-side tax. Commission is either the scaling model (when
 * `frictions.commission` is set) or the flat max(bps-of-notional, floor).
 */
function totalFee(
  notional: number,
  side: Side,
  baseFee: number,
  f: Frictions | undefined,
  ctx?: FeeContext,
): number {
  if (!f) return baseFee;
  let commission: number;
  if (f.commission) {
    const c = f.commission;
    const symbol = ctx?.symbol ?? "";
    commission = computeCommission({
      notional,
      quantity: ctx?.quantity ?? 0,
      symbol,
      ...(c.currencyBySymbol?.[symbol] ? { currency: c.currencyBySymbol[symbol] } : {}),
      ...(c.assetClassBySymbol?.[symbol]
        ? { assetClass: c.assetClassBySymbol[symbol] }
        : {}),
      ...(c.monthlyVolume !== undefined ? { monthlyVolume: c.monthlyVolume } : {}),
      ...(c.model ? { model: c.model } : {}),
    }).commission;
  } else {
    const bpsComm = notional * ((f.commissionBps ?? 0) / 10_000);
    commission = Math.max(f.minCommission ?? 0, bpsComm);
  }
  const tax = side === "BUY" ? notional * ((f.buyTaxBps ?? 0) / 10_000) : 0;
  return baseFee + commission + tax;
}

/**
 * Largest BUY quantity in [0, requested] such that
 *   qty*effPrice(qty) + totalFee(qty*effPrice(qty)) <= cash.
 * Solved by bisection to keep the closed-form independent of the
 * chosen friction model. 40 iterations gives ~1e-12 relative precision.
 */
function maxAffordableBuyQty(
  requested: number,
  quote: number,
  cash: number,
  baseFee: number,
  f: Frictions,
  symbol: string,
): number {
  const spendAt = (q: number): number => {
    const p = effectiveFillPrice(quote, q, "BUY", f);
    const notional = q * p;
    return notional + totalFee(notional, "BUY", baseFee, f, { symbol, quantity: q });
  };
  if (spendAt(requested) <= cash) return requested;
  if (spendAt(0) > cash) return 0; // fixed fees alone unaffordable
  let lo = 0;
  let hi = requested;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (spendAt(mid) <= cash) lo = mid; else hi = mid;
  }
  return lo;
}

function cloneHoldings(hs: SimHolding[]): SimHolding[] {
  return hs.map((h) => ({ symbol: h.symbol, quantity: h.quantity, avgCost: h.avgCost }));
}

function markToMarket(
  holdings: SimHolding[],
  markPrices: Record<string, number> | undefined,
): number {
  let sum = 0;
  for (const h of holdings) {
    const mark = markPrices?.[h.symbol];
    const price = Number.isFinite(mark) ? Number(mark) : h.avgCost;
    // Zero or negative prices contribute 0 rather than a negative
    // holdings value (no shorting means value can't be < 0).
    const safe = Number.isFinite(price) && price > 0 ? price : 0;
    sum += h.quantity * safe;
  }
  return sum;
}

/**
 * Reduce a rolling window of recent bar volumes to a single ADV-like
 * figure. Filters out non-finite / negative entries first. Returns
 * `null` when nothing usable remains so callers can fall through to
 * the next precedence tier instead of capping at zero.
 */
function aggregateVolumeHistory(
  history: readonly number[] | undefined,
  window: number | undefined,
  how: "mean" | "median" | "min" | undefined,
): number | null {
  if (!history || history.length === 0) return null;
  const clean = history.filter(
    (v) => Number.isFinite(v) && (v as number) >= 0,
  );
  if (clean.length === 0) return null;
  const n = Number.isFinite(window) && (window as number) > 0
    ? Math.min(clean.length, Math.floor(window as number))
    : clean.length;
  const tail = clean.slice(clean.length - n);
  const agg = how ?? "mean";
  if (agg === "min") return Math.min(...tail);
  if (agg === "median") {
    const sorted = [...tail].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }
  let sum = 0;
  for (const v of tail) sum += v;
  return sum / tail.length;
}

/**
 * Compute the maximum fill quantity permitted by the liquidity model
 * for a given decision. Returns `Infinity` when no cap applies, `0`
 * when the market is dry, or a finite positive cap otherwise.
 *
 * Precedence for the raw volume estimate (highest first):
 *   1. per-decision `availableVolume`
 *   2. per-decision `volumeHistory` (reduced via rolling window)
 *   3. per-symbol   `availableVolume[symbol]`
 *   4. per-symbol   `volumeHistory[symbol]` (reduced via rolling window)
 *   5. unconstrained (`Infinity`)
 * `maxParticipationRate` scales whichever tier resolves.
 */
function liquidityCap(
  d: SimDecision,
  liquidity: SimulateOptions["liquidity"],
): { cap: number; rawVolume: number | null } {
  const window = liquidity?.rollingWindow;
  const agg = liquidity?.volumeAggregator;

  let vol: number | null = null;
  const perDecision = d.availableVolume;
  if (Number.isFinite(perDecision) && (perDecision as number) >= 0) {
    vol = perDecision as number;
  }
  if (vol === null) {
    vol = aggregateVolumeHistory(d.volumeHistory, window, agg);
  }
  if (vol === null) {
    const perSymbol = liquidity?.availableVolume?.[d.symbol];
    if (Number.isFinite(perSymbol) && (perSymbol as number) >= 0) {
      vol = perSymbol as number;
    }
  }
  if (vol === null) {
    vol = aggregateVolumeHistory(
      liquidity?.volumeHistory?.[d.symbol], window, agg,
    );
  }
  if (vol === null) return { cap: Number.POSITIVE_INFINITY, rawVolume: null };

  const rate = liquidity?.maxParticipationRate;
  const rateClamped = Number.isFinite(rate) && (rate as number) > 0
    ? Math.min(1, rate as number)
    : 1;
  return { cap: vol * rateClamped, rawVolume: vol };
}

/**
 * Signed slippage in basis points, oriented so positive = adverse for
 * the trader (BUY paid up, SELL received less). Returns 0 when the
 * expected price is <= 0 or the fill quantity is 0.
 */
function slippageBpsOf(
  side: Side,
  expectedPrice: number,
  fillPrice: number,
  fillQty: number,
): number {
  if (!(expectedPrice > 0) || fillQty <= 0) return 0;
  const diff = side === "BUY"
    ? fillPrice - expectedPrice
    : expectedPrice - fillPrice;
  return (diff / expectedPrice) * 10_000;
}

/**
 * Build the execution-quality fields tacked onto every emitted snapshot.
 * `rawVolume` is the pre-participation-rate liquidity estimate
 * (`null` when the symbol was unconstrained).
 */
function qualityFields(
  side: Side,
  expectedPrice: number,
  fillPrice: number,
  fillQty: number,
  rawVolume: number | null,
): Pick<
  SimSnapshot,
  "expectedPrice" | "slippageBps" | "participationRate"
    | "liquidityAdjustedSlippageBps"
> {
  const slippageBps = slippageBpsOf(side, expectedPrice, fillPrice, fillQty);
  const participationRate =
    rawVolume !== null && rawVolume > 0
      ? Math.min(1, fillQty / rawVolume)
      : null;
  const liquidityAdjustedSlippageBps =
    participationRate !== null && participationRate > 0
      ? slippageBps / participationRate
      : null;
  return {
    expectedPrice,
    slippageBps,
    participationRate,
    liquidityAdjustedSlippageBps,
  };
}



export function simulateBrokerExecution(
  initial: SimState,
  decisions: SimDecision[],
  options: SimulateOptions = {},
): SimulateResult {
  const truncateBuys = options.truncateBuysToCash ?? true;
  const truncateSells = options.truncateSellsToPosition ?? true;

  // Defensive validation of the starting state — refusing to run on a
  // malformed state prevents silent drift downstream.
  if (!isFiniteNonNeg(initial.cash)) {
    throw new Error("initial.cash must be a finite non-negative number");
  }
  for (const h of initial.holdings) {
    if (!isFiniteNonNeg(h.quantity)) throw new Error(`holding ${h.symbol}: quantity must be finite & >= 0`);
    if (!isFiniteNonNeg(h.avgCost)) throw new Error(`holding ${h.symbol}: avgCost must be finite & >= 0`);
  }

  let cash = initial.cash;
  let holdings = cloneHoldings(initial.holdings);
  const snapshots: SimSnapshot[] = [];
  const rejections: SimRejection[] = [];

  // Phase B — fold the algo-regime snapshot into effective options.
  // We tighten `liquidity.maxParticipationRate` (never loosen it) and
  // pre-reject BUYs when the guard recommends blocking new market buys.
  const regime = options.algoRegime ?? null;
  if (regime) {
    const eff = effectiveMaxParticipation(options.liquidity?.maxParticipationRate, regime);
    if (eff !== null) {
      options = {
        ...options,
        liquidity: { ...(options.liquidity ?? {}), maxParticipationRate: eff },
      };
    }
  }

  // Queue-based dispatch so a liquidity-truncated fill can enqueue its
  // residual as a follow-up decision when `timeSliceUnfilled` is on.
  // Each entry carries the parent decision id and the slice number so
  // downstream observers can stitch the sliced fills back together.
  type QueueItem = {
    decision: SimDecision;
    sliceOf: string;   // original decision id (== decision.id for parents)
    sliceIndex: number; // 0 for parent, 1..N for time-slice residuals
    /** Extra attempts still allowed AFTER this one. 0 means this is the
     * last chance — any residual is dropped rather than re-queued. */
    attemptsRemaining: number;
  };
  const sliceMax = Math.max(0, options.timeSliceMaxAttempts ?? 5);
  const blockBuys = !!regime?.multipliers.blockNewBuys;
  if (blockBuys) {
    // Emit typed rejections up-front (before validation) so the report
    // reflects the guard cleanly and no cash/position math ever runs.
    let step = 0;
    for (const d of decisions) {
      step += 1;
      if (d.side === "BUY") {
        rejections.push({
          step, decisionId: d.id, symbol: d.symbol, side: d.side,
          reason: "algo_regime_block",
          requested: { quantity: d.quantity, price: d.price, fee: d.fee ?? 0 },
        });
      }
    }
  }
  const queue: QueueItem[] = decisions
    .filter((d) => !(blockBuys && d.side === "BUY"))
    .map((d) => ({
      decision: d, sliceOf: d.id, sliceIndex: 0,
      attemptsRemaining: options.timeSliceUnfilled ? sliceMax : 0,
    }));

  // Threaded through each iteration so the per-branch snapshot pushes
  // can tag their emissions with the correct slice metadata.
  let curSliceOf = "";
  let curSliceIndex = 0;
  let curAttemptsRemaining = 0;

  /**
   * After a snapshot has been pushed, decide whether to enqueue a
   * residual continuation. Only liquidity-driven partials get sliced —
   * cash/position truncations mean the ledger itself couldn't take
   * more, not that the market couldn't supply it.
   */
  const maybeEnqueueResidual = (
    d: SimDecision,
    filledQty: number,
  ): void => {
    if (!options.timeSliceUnfilled || curAttemptsRemaining <= 0) return;
    const s = snapshots[snapshots.length - 1];
    if (!s || s.truncationReason !== "liquidity") return;
    const residual = d.quantity - filledQty;
    if (residual <= 1e-12) return;
    queue.push({
      decision: {
        ...d,
        id: `${curSliceOf}#slice-${curSliceIndex + 1}`,
        quantity: residual,
      },
      sliceOf: curSliceOf,
      sliceIndex: curSliceIndex + 1,
      attemptsRemaining: curAttemptsRemaining - 1,
    });
  };

  let step = 0;
  while (queue.length > 0) {
    const item = queue.shift()!;
    const d = item.decision;
    curSliceOf = item.sliceOf;
    curSliceIndex = item.sliceIndex;
    curAttemptsRemaining = item.attemptsRemaining;
    step += 1;
    const fee = d.fee ?? 0;


    // ---- input validation ------------------------------------------------
    if (!Number.isFinite(d.quantity) || d.quantity <= 0) {
      rejections.push({
        step, decisionId: d.id, symbol: d.symbol, side: d.side,
        reason: "invalid_quantity",
        requested: { quantity: d.quantity, price: d.price, fee },
      });
      continue;
    }
    if (!Number.isFinite(d.price) || d.price < 0) {
      rejections.push({
        step, decisionId: d.id, symbol: d.symbol, side: d.side,
        reason: "invalid_price",
        requested: { quantity: d.quantity, price: d.price, fee },
      });
      continue;
    }
    if (!isFiniteNonNeg(fee)) {
      rejections.push({
        step, decisionId: d.id, symbol: d.symbol, side: d.side,
        reason: "invalid_fee",
        requested: { quantity: d.quantity, price: d.price, fee },
      });
      continue;
    }

    // ---- liquidity gate --------------------------------------------------
    // Runs BEFORE cash/position sizing so participation is measured against
    // the market's ability to fill, not against our remaining budget.
    const originalRequested = d.quantity;
    const { cap: liqCap, rawVolume: liqRawVolume } =
      liquidityCap(d, options.liquidity);
    if (liqCap <= 0) {
      rejections.push({
        step, decisionId: d.id, symbol: d.symbol, side: d.side,
        reason: "no_liquidity",
        requested: { quantity: d.quantity, price: d.price, fee },
      });
      continue;
    }
    const requestedAfterLiquidity = Math.min(originalRequested, liqCap);

    const liquidityTruncated =
      requestedAfterLiquidity < originalRequested - 1e-12;
    const minFill = options.liquidity?.minFillQuantity ?? 0;
    if (liquidityTruncated && requestedAfterLiquidity < minFill) {
      rejections.push({
        step, decisionId: d.id, symbol: d.symbol, side: d.side,
        reason: "no_liquidity",
        requested: { quantity: d.quantity, price: d.price, fee },
      });
      continue;
    }

    if (d.side === "BUY") {
      const f = options.frictions;
      let cashTruncated = false;

      // Frictionless path (unchanged) — preserves byte-for-byte legacy
      // behaviour when no cost model is configured.
      if (!f) {
        if (fee > cash) {
          rejections.push({
            step, decisionId: d.id, symbol: d.symbol, side: d.side,
            reason: "insufficient_cash",
            requested: { quantity: d.quantity, price: d.price, fee },
          });
          continue;
        }
        const cashAfterFee = cash - fee;
        let qty = requestedAfterLiquidity;
        const cost = qty * d.price;
        if (cost > cashAfterFee) {
          if (!truncateBuys) {
            rejections.push({
              step, decisionId: d.id, symbol: d.symbol, side: d.side,
              reason: "would_borrow",
              requested: { quantity: d.quantity, price: d.price, fee },
            });
            continue;
          }
          cashTruncated = true;
          qty = d.price > 0 ? Math.max(0, cashAfterFee / d.price) : 0;
          if (qty <= 0) {
            rejections.push({
              step, decisionId: d.id, symbol: d.symbol, side: d.side,
              reason: "insufficient_cash",
              requested: { quantity: d.quantity, price: d.price, fee },
            });
            continue;
          }
        }
        const spend = qty * d.price + fee;
        cash = Math.max(0, cash - spend);

        const existing = holdings.find((h) => h.symbol === d.symbol);
        if (existing) {
          const totalCost = existing.quantity * existing.avgCost + qty * d.price;
          const totalQty = existing.quantity + qty;
          existing.quantity = totalQty;
          existing.avgCost = totalQty > 0 ? totalCost / totalQty : 0;
        } else {
          holdings.push({ symbol: d.symbol, quantity: qty, avgCost: d.price });
        }

        const holdingsValue = markToMarket(holdings, options.markPrices);
        const truncationReason: SimSnapshot["truncationReason"] =
          liquidityTruncated ? "liquidity" : cashTruncated ? "cash" : null;
        snapshots.push({
          step, decisionId: d.id, symbol: d.symbol, side: d.side,
          cash, holdings: cloneHoldings(holdings),
          holdingsValue, totalValue: cash + holdingsValue,
          realizedPnl: 0,
          fillQuantity: qty, fillPrice: d.price, fee,
          requestedQuantity: originalRequested,
          partial: qty < originalRequested - 1e-12,
          truncationReason,
          ...qualityFields("BUY", d.price, d.price, qty, liqRawVolume),

          ...(options.timeSliceUnfilled
            ? { sliceOf: curSliceOf, sliceIndex: curSliceIndex }
            : {}),
        });
        maybeEnqueueResidual(d, qty);
        continue;
      }

      // ---- Friction-aware BUY --------------------------------------------
      const requested = requestedAfterLiquidity;
      const requestedEffPrice = effectiveFillPrice(d.price, requested, "BUY", f);
      const requestedNotional = requested * requestedEffPrice;
      const requestedSpend =
        requestedNotional
        + totalFee(requestedNotional, "BUY", fee, f, { symbol: d.symbol, quantity: requested });

      let qty = requested;
      if (requestedSpend > cash) {
        if (!truncateBuys) {
          rejections.push({
            step, decisionId: d.id, symbol: d.symbol, side: d.side,
            reason: "would_borrow",
            requested: { quantity: d.quantity, price: d.price, fee },
          });
          continue;
        }
        cashTruncated = true;
        qty = maxAffordableBuyQty(requested, d.price, cash, fee, f, d.symbol);
        if (qty <= 0) {
          rejections.push({
            step, decisionId: d.id, symbol: d.symbol, side: d.side,
            reason: "insufficient_cash",
            requested: { quantity: d.quantity, price: d.price, fee },
          });
          continue;
        }
      }

      const effPrice = effectiveFillPrice(d.price, qty, "BUY", f);
      const notional = qty * effPrice;
      const totalFeePaid = totalFee(notional, "BUY", fee, f, { symbol: d.symbol, quantity: qty });
      const spend = notional + totalFeePaid;
      cash = Math.max(0, cash - spend);

      const existing = holdings.find((h) => h.symbol === d.symbol);
      if (existing) {
        const totalCost = existing.quantity * existing.avgCost + qty * effPrice;
        const totalQty = existing.quantity + qty;
        existing.quantity = totalQty;
        existing.avgCost = totalQty > 0 ? totalCost / totalQty : 0;
      } else {
        holdings.push({ symbol: d.symbol, quantity: qty, avgCost: effPrice });
      }

      const holdingsValue = markToMarket(holdings, options.markPrices);
      const truncationReason: SimSnapshot["truncationReason"] =
        liquidityTruncated ? "liquidity" : cashTruncated ? "cash" : null;
      snapshots.push({
        step, decisionId: d.id, symbol: d.symbol, side: d.side,
        cash, holdings: cloneHoldings(holdings),
        holdingsValue, totalValue: cash + holdingsValue,
        realizedPnl: 0,
        fillQuantity: qty, fillPrice: effPrice, fee: totalFeePaid,
        requestedQuantity: originalRequested,
        partial: qty < originalRequested - 1e-12,
        truncationReason,
        ...qualityFields("BUY", d.price, effPrice, qty, liqRawVolume),

        ...(options.timeSliceUnfilled
          ? { sliceOf: curSliceOf, sliceIndex: curSliceIndex }
          : {}),
      });
      maybeEnqueueResidual(d, qty);
      continue;
    }

    // ---- SELL ------------------------------------------------------------
    const existing = holdings.find((h) => h.symbol === d.symbol);
    const held = existing?.quantity ?? 0;
    if (held <= 0) {
      rejections.push({
        step, decisionId: d.id, symbol: d.symbol, side: d.side,
        reason: "no_position_to_sell",
        requested: { quantity: d.quantity, price: d.price, fee },
      });
      continue;
    }
    let qty = requestedAfterLiquidity;
    let positionTruncated = false;
    if (qty > held) {
      if (!truncateSells) {
        rejections.push({
          step, decisionId: d.id, symbol: d.symbol, side: d.side,
          reason: "would_short",
          requested: { quantity: d.quantity, price: d.price, fee },
        });
        continue;
      }
      positionTruncated = true;
      qty = held;
    }
    const f = options.frictions;
    const effSellPrice = effectiveFillPrice(d.price, qty, "SELL", f);
    const proceeds = qty * effSellPrice;
    const totalFeePaid = totalFee(proceeds, "SELL", fee, f, { symbol: d.symbol, quantity: qty });
    if (totalFeePaid > cash + proceeds) {
      rejections.push({
        step, decisionId: d.id, symbol: d.symbol, side: d.side,
        reason: "insufficient_cash",
        requested: { quantity: d.quantity, price: d.price, fee },
      });
      continue;
    }
    cash = Math.max(0, cash + proceeds - totalFeePaid);
    const realizedPnl =
      (effSellPrice - (existing?.avgCost ?? 0)) * qty - totalFeePaid;
    if (existing) {
      existing.quantity -= qty;
      if (existing.quantity <= 0) {
        holdings = holdings.filter((h) => h.symbol !== d.symbol);
      }
    }

    const holdingsValue = markToMarket(holdings, options.markPrices);
    const truncationReason: SimSnapshot["truncationReason"] =
      liquidityTruncated ? "liquidity" : positionTruncated ? "position" : null;
    snapshots.push({
      step, decisionId: d.id, symbol: d.symbol, side: d.side,
      cash, holdings: cloneHoldings(holdings),
      holdingsValue, totalValue: cash + holdingsValue,
      realizedPnl,
      fillQuantity: qty, fillPrice: effSellPrice, fee: totalFeePaid,
      requestedQuantity: originalRequested,
      partial: qty < originalRequested - 1e-12,
      truncationReason,
      ...qualityFields("SELL", d.price, effSellPrice, qty, liqRawVolume),

      ...(options.timeSliceUnfilled
        ? { sliceOf: curSliceOf, sliceIndex: curSliceIndex }
        : {}),
    });
    maybeEnqueueResidual(d, qty);
  }

  return {
    finalState: { cash, holdings },
    snapshots,
    rejections,
    executionQuality: buildExecutionQualityReport(
      decisions.length, snapshots, rejections,
    ),
  };
}

/**
 * Aggregate the per-snapshot quality fields into the top-level
 * `ExecutionQualityReport`. Kept as a standalone function so tests
 * (and external callers) can re-run it against edited snapshot arrays
 * without re-executing the whole simulator.
 */
export function buildExecutionQualityReport(
  decisionCount: number,
  snapshots: readonly SimSnapshot[],
  rejections: readonly SimRejection[],
): ExecutionQualityReport {
  const rejectionsByReason: Record<SimRejection["reason"], number> = {
    invalid_quantity: 0,
    invalid_price: 0,
    invalid_fee: 0,
    no_position_to_sell: 0,
    insufficient_cash: 0,
    would_borrow: 0,
    would_short: 0,
    no_liquidity: 0,
    algo_regime_block: 0,
  };
  for (const r of rejections) rejectionsByReason[r.reason] += 1;

  // Only parent snapshots (sliceIndex 0 or absent) contribute to
  // "requested" totals — sliced residuals inherit that requested qty.
  let totalRequested = 0;
  let totalFilled = 0;
  let fullyFilledCount = 0;
  let partialFillCount = 0;

  let slipWeightSum = 0;
  let slipNumerator = 0;
  let liqAdjWeightSum = 0;
  let liqAdjNumerator = 0;
  let partRateSum = 0;
  let partRateCount = 0;

  type Bucket = {
    requested: number; filled: number; fillCount: number;
    slipW: number; slipN: number;
    liqAdjW: number; liqAdjN: number;
    partSum: number; partCount: number;
  };
  const bucket = (): Bucket => ({
    requested: 0, filled: 0, fillCount: 0,
    slipW: 0, slipN: 0, liqAdjW: 0, liqAdjN: 0,
    partSum: 0, partCount: 0,
  });
  const bySymbolRaw = new Map<string, Bucket>();


  for (const s of snapshots) {
    const isParent = (s.sliceIndex ?? 0) === 0;
    if (isParent) totalRequested += s.requestedQuantity;
    totalFilled += s.fillQuantity;
    if (s.fillQuantity > 0 && !s.partial) fullyFilledCount += 1;
    if (s.partial) partialFillCount += 1;

    const w = s.fillQuantity * (s.expectedPrice > 0 ? s.expectedPrice : 1);
    if (s.fillQuantity > 0) {
      slipWeightSum += w;
      slipNumerator += w * s.slippageBps;
      if (s.liquidityAdjustedSlippageBps !== null) {
        liqAdjWeightSum += w;
        liqAdjNumerator += w * s.liquidityAdjustedSlippageBps;
      }
      if (s.participationRate !== null) {
        partRateSum += s.participationRate;
        partRateCount += 1;
      }
    }

    const sym = s.symbol;
    const b = bySymbolRaw.get(sym) ?? bucket();
    if (isParent) b.requested += s.requestedQuantity;
    b.filled += s.fillQuantity;
    if (s.fillQuantity > 0) {
      b.fillCount += 1;
      b.slipW += w;
      b.slipN += w * s.slippageBps;
      if (s.liquidityAdjustedSlippageBps !== null) {
        b.liqAdjW += w;
        b.liqAdjN += w * s.liquidityAdjustedSlippageBps;
      }
      if (s.participationRate !== null) {
        b.partSum += s.participationRate;
        b.partCount += 1;
      }
    }
    bySymbolRaw.set(sym, b);
  }

  const bySymbol: ExecutionQualityReport["bySymbol"] = {};
  for (const [sym, b] of bySymbolRaw) {
    bySymbol[sym] = {
      requested: b.requested,
      filled: b.filled,
      fillRatio: b.requested > 0
        ? Math.min(1, Math.max(0, b.filled / b.requested))
        : 1,
      weightedAvgSlippageBps: b.slipW > 0 ? b.slipN / b.slipW : 0,
      weightedAvgLiquidityAdjustedSlippageBps:
        b.liqAdjW > 0 ? b.liqAdjN / b.liqAdjW : null,
      avgParticipationRate:
        b.partCount > 0 ? b.partSum / b.partCount : null,
      fillCount: b.fillCount,
    };
  }

  return {
    decisionCount,
    totalRequested,
    totalFilled,
    fillRatio: totalRequested > 0
      ? Math.min(1, Math.max(0, totalFilled / totalRequested))
      : 1,
    fullyFilledCount,
    partialFillCount,
    rejectionCount: rejections.length,
    rejectionsByReason,
    weightedAvgSlippageBps:
      slipWeightSum > 0 ? slipNumerator / slipWeightSum : 0,
    weightedAvgLiquidityAdjustedSlippageBps:
      liqAdjWeightSum > 0 ? liqAdjNumerator / liqAdjWeightSum : null,
    avgParticipationRate:
      partRateCount > 0 ? partRateSum / partRateCount : null,
    bySymbol,
  };
}

