// Single source of truth for tail-hedge order sizing.
//
// The Phase 6 backtest runner and the live/paper executor must size hedge
// legs identically, otherwise a backtest silently models a different book
// than the one that actually trades. Both previously carried their own copy
// of the "how many shares can I afford / unwind" rule and drifted apart:
// the runner required a whole share's worth of spend while the executor
// booked fractional units for paper, so parity tests saw fills on one side
// and deferrals on the other.
//
// Every sizing decision now flows through the two functions below.

/** Quantities below this are dust — not worth a ticket, and not a blocker. */
export const HEDGE_DUST_QTY = 1e-8;
/** Smallest notional worth booking as a hedge leg. */
export const HEDGE_MIN_TICKET_NOTIONAL = 1;

export type HedgeBuySizing =
  | { ok: true; qty: number; spend: number; partial: boolean }
  | { ok: false; reason: "insufficient_cash" };

export type HedgeSellSizing =
  | { ok: true; qty: number; partial: boolean }
  | { ok: false; reason: "no_position_to_unwind" };

/**
 * Size a hedge BUY under no-leverage / no-borrow rules.
 *
 * - `cash * (1 - bufferPct)` is the hard spending cap (never borrow).
 * - `wholeShares` (live venues) floors to whole units and requires at least
 *   one full share of budget; fractional books only need a minimum ticket.
 * - `effectivePrice` lets a caller fold fee/slippage bps into the fill price
 *   while still reporting `price` (the clean mark) on the trade.
 */
export function sizeHedgeBuy(input: {
  deltaNotional: number;
  cash: number;
  price: number;
  bufferPct: number;
  wholeShares: boolean;
  effectivePrice?: number;
}): HedgeBuySizing {
  const { deltaNotional, cash, price, bufferPct, wholeShares } = input;
  const fillPrice = input.effectivePrice ?? price;
  if (!(price > 0) || !(fillPrice > 0)) return { ok: false, reason: "insufficient_cash" };

  const affordable = Math.max(0, cash * (1 - bufferPct));
  const spend = Math.min(deltaNotional, affordable);
  // Whole-share venues need a full share of budget; fractional books just
  // need a ticket worth booking.
  const minSpend = wholeShares ? fillPrice : Math.min(fillPrice, HEDGE_MIN_TICKET_NOTIONAL);
  if (spend < minSpend) return { ok: false, reason: "insufficient_cash" };

  const rawQty = spend / fillPrice;
  const qty = wholeShares ? Math.floor(rawQty) : rawQty;
  if (qty <= 0) return { ok: false, reason: "insufficient_cash" };

  return {
    ok: true,
    qty,
    spend: qty * fillPrice,
    partial: deltaNotional - qty * fillPrice > HEDGE_MIN_TICKET_NOTIONAL,
  };
}

/**
 * Size a hedge SELL (unwind) — never short, never leave unsellable dust.
 */
export function sizeHedgeSell(input: {
  deltaNotional: number;
  heldQty: number;
  price: number;
  wholeShares: boolean;
}): HedgeSellSizing {
  const { deltaNotional, heldQty, price, wholeShares } = input;
  if (!(price > 0) || heldQty <= HEDGE_DUST_QTY) {
    return { ok: false, reason: "no_position_to_unwind" };
  }

  const wantQty = Math.abs(deltaNotional) / price;
  let qty = Math.min(heldQty, wantQty);

  if (wholeShares) {
    // Whole shares only at the broker — but never round a real reduction down
    // to nothing: if the clip floors to zero, or the residual would be an
    // unsellable odd lot, close what's there instead of suppressing the trim.
    const floored = Math.floor(qty);
    if (floored <= 0) qty = heldQty <= 1 ? heldQty : 1;
    else if (heldQty - floored <= 1) qty = heldQty;
    else qty = floored;
  }

  if (qty <= HEDGE_DUST_QTY) return { ok: false, reason: "no_position_to_unwind" };
  // Leaving dust behind costs another ticket later; close the tail instead.
  if (heldQty - qty <= HEDGE_DUST_QTY) qty = heldQty;

  return {
    ok: true,
    qty,
    partial: Math.abs(deltaNotional) - qty * price > HEDGE_MIN_TICKET_NOTIONAL,
  };
}
