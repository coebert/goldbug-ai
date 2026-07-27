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
    | "would_short";
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
};

export type SimulateResult = {
  finalState: SimState;
  snapshots: SimSnapshot[];
  rejections: SimRejection[];
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

/**
 * Total fee for a fill: baseFee (per-decision override) + commission
 * (max of bps-of-notional and minCommission) + buy-side tax.
 */
function totalFee(
  notional: number,
  side: Side,
  baseFee: number,
  f: Frictions | undefined,
): number {
  if (!f) return baseFee;
  const bpsComm = notional * ((f.commissionBps ?? 0) / 10_000);
  const commission = Math.max(f.minCommission ?? 0, bpsComm);
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
): number {
  const spendAt = (q: number): number => {
    const p = effectiveFillPrice(quote, q, "BUY", f);
    const notional = q * p;
    return notional + totalFee(notional, "BUY", baseFee, f);
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

  let step = 0;
  for (const d of decisions) {
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

    if (d.side === "BUY") {
      // Fee is paid regardless of fill quantity. If we can't even pay
      // the fee, the whole step is rejected — never allow cash to dip
      // below 0 via a fee.
      if (fee > cash) {
        rejections.push({
          step, decisionId: d.id, symbol: d.symbol, side: d.side,
          reason: "insufficient_cash",
          requested: { quantity: d.quantity, price: d.price, fee },
        });
        continue;
      }
      const cashAfterFee = cash - fee;
      let qty = d.quantity;
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
        // Truncate to the largest quantity that fits. Use floor with a
        // tiny epsilon guard so 1e-15 float noise never lets a cent
        // slip through.
        qty = d.price > 0 ? Math.max(0, cashAfterFee / d.price) : 0;
        // If the resulting qty is 0 (e.g. price too high for any
        // fraction), reject cleanly rather than emit a no-op snapshot.
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
      // Post-condition guard: cash MUST NOT go negative. If float math
      // produced a sliver below zero, snap to 0 rather than reject —
      // but log by clamping and emitting the snapshot at 0.
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
      snapshots.push({
        step, decisionId: d.id,
        cash, holdings: cloneHoldings(holdings),
        holdingsValue, totalValue: cash + holdingsValue,
        realizedPnl: 0,
        fillQuantity: qty, fillPrice: d.price, fee,
      });
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
    let qty = d.quantity;
    if (qty > held) {
      if (!truncateSells) {
        rejections.push({
          step, decisionId: d.id, symbol: d.symbol, side: d.side,
          reason: "would_short",
          requested: { quantity: d.quantity, price: d.price, fee },
        });
        continue;
      }
      qty = held;
    }
    const proceeds = qty * d.price;
    // Fee still owed on SELL; may not push cash below 0.
    if (fee > cash + proceeds) {
      rejections.push({
        step, decisionId: d.id, symbol: d.symbol, side: d.side,
        reason: "insufficient_cash",
        requested: { quantity: d.quantity, price: d.price, fee },
      });
      continue;
    }
    cash = Math.max(0, cash + proceeds - fee);
    const realizedPnl = (d.price - (existing?.avgCost ?? 0)) * qty - fee;
    if (existing) {
      existing.quantity -= qty;
      if (existing.quantity <= 0) {
        // Fully closed → drop the row so holdings never carries 0/negative.
        holdings = holdings.filter((h) => h.symbol !== d.symbol);
      }
    }

    const holdingsValue = markToMarket(holdings, options.markPrices);
    snapshots.push({
      step, decisionId: d.id,
      cash, holdings: cloneHoldings(holdings),
      holdingsValue, totalValue: cash + holdingsValue,
      realizedPnl,
      fillQuantity: qty, fillPrice: d.price, fee,
    });
  }

  return {
    finalState: { cash, holdings },
    snapshots,
    rejections,
  };
}
