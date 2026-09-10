// Core allocation ("don't leave the money in cash").
//
// The account's own history says idle cash is its single biggest profit leak:
// on real prices from 2021 the trading sleeve alone made +11.9%, while holding
// a fixed core in a broad world tracker and trading the rest made +49.3%.
// This module decides, deterministically, how much of the core to buy or trim
// so the account keeps that baseline invested without the AI having to think
// about it.
//
// It only ever moves the account TOWARDS the target: it buys with cash that is
// already free after the reserve, and it trims only when the core has drifted
// above the target band. It never borrows and never sells the trading sleeve.

export type CoreAllocationInput = {
  /** Total account value in base ccy. */
  nav: number;
  /** Current market value of the core holding, base ccy. */
  coreValue: number;
  /** Free cash in base ccy. */
  cash: number;
  /** Cash that must stay untouched (reserve, pending orders, fees). */
  cashReserve: number;
  /** Live price of one unit of the core holding, base ccy. */
  price: number;
  /** Target share of NAV to hold in the core, 0–1. */
  targetPct: number;
  /** Drift allowed either side of the target before acting, 0–1. */
  bandPct: number;
  /** Smallest ticket worth paying dealing costs on, base ccy. */
  minTicket: number;
};

export type CoreAllocationPlan = {
  action: "buy" | "trim" | "hold";
  quantity: number;
  notional: number;
  currentPct: number;
  targetPct: number;
  reason: string;
};

export function planCoreAllocation(input: CoreAllocationInput): CoreAllocationPlan {
  const {
    nav, coreValue, cash, cashReserve, price, targetPct, bandPct, minTicket,
  } = input;

  const currentPct = nav > 0 ? coreValue / nav : 0;
  const hold = (reason: string): CoreAllocationPlan => ({
    action: "hold", quantity: 0, notional: 0, currentPct, targetPct, reason,
  });

  if (!(targetPct > 0)) return hold("Core holding is switched off.");
  if (!(nav > 0) || !(price > 0)) return hold("No usable account value or price for the core holding.");

  const lower = Math.max(0, targetPct - bandPct);
  const upper = Math.min(1, targetPct + bandPct);

  if (currentPct < lower) {
    const wanted = nav * targetPct - coreValue;
    const spendable = Math.max(0, cash - cashReserve);
    const spend = Math.min(wanted, spendable);
    const quantity = Math.floor(spend / price);
    const notional = quantity * price;
    if (quantity < 1) {
      return hold(
        `Core is ${(currentPct * 100).toFixed(0)}% of the account against a ${(targetPct * 100).toFixed(0)}% target, but there is not enough free cash to buy a whole unit.`,
      );
    }
    if (notional < minTicket) {
      return hold(
        `Core is ${(currentPct * 100).toFixed(0)}% of the account, but a £${notional.toFixed(0)} top-up is too small to be worth the dealing cost.`,
      );
    }
    return {
      action: "buy",
      quantity,
      notional,
      currentPct,
      targetPct,
      reason: `Core is ${(currentPct * 100).toFixed(0)}% of the account against a ${(targetPct * 100).toFixed(0)}% target — putting £${notional.toFixed(0)} of idle cash to work.`,
    };
  }

  if (currentPct > upper) {
    const excess = coreValue - nav * targetPct;
    const quantity = Math.floor(excess / price);
    const notional = quantity * price;
    if (quantity < 1 || notional < minTicket) {
      return hold(
        `Core is ${(currentPct * 100).toFixed(0)}% of the account — slightly over target, but too small an overshoot to be worth trimming.`,
      );
    }
    return {
      action: "trim",
      quantity,
      notional,
      currentPct,
      targetPct,
      reason: `Core has grown to ${(currentPct * 100).toFixed(0)}% of the account against a ${(targetPct * 100).toFixed(0)}% target — selling £${notional.toFixed(0)} back into cash for the trading sleeve.`,
    };
  }

  return hold(
    `Core is ${(currentPct * 100).toFixed(0)}% of the account, within the ${(bandPct * 100).toFixed(0)}% band around the ${(targetPct * 100).toFixed(0)}% target.`,
  );
}
