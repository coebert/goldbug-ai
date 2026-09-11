// Cash sleeve ("don't let spare cash sit idle at 0%").
//
// The account routinely carries most of its value in cash between trades. Cash
// earns nothing at the broker, so anything above the working buffer is parked
// in a cash-like interest fund (short-dated GBP bonds / overnight rate) and
// sold back the moment the buffer is short.
//
// This is deliberately NOT a trading idea: the sleeve is sized by the cash
// balance alone, never by a signal, and it is always sold before it blocks a
// real trade.

export type CashSleeveInput = {
  /** Total account value in base ccy. */
  nav: number;
  /** Current market value of the cash-like fund, base ccy. */
  sleeveValue: number;
  /** Units of the cash-like fund currently held. */
  sleeveQuantity: number;
  /** Free cash in base ccy. */
  cash: number;
  /** Cash that must always stay liquid for trades, charges and settlement. */
  buffer: number;
  /** Live price of one unit of the cash-like fund, base ccy. */
  price: number;
  /** Smallest ticket worth paying dealing costs on, base ccy. */
  minTicket: number;
};

export type CashSleevePlan = {
  action: "buy" | "sell" | "hold";
  quantity: number;
  notional: number;
  reason: string;
};

export function planCashSleeve(input: CashSleeveInput): CashSleevePlan {
  const { nav, sleeveValue, sleeveQuantity, cash, buffer, price, minTicket } = input;
  const hold = (reason: string): CashSleevePlan => ({
    action: "hold", quantity: 0, notional: 0, reason,
  });

  if (!(price > 0) || !Number.isFinite(price)) return hold("No usable price for the interest fund.");
  if (!Number.isFinite(cash)) return hold("No usable cash balance.");

  const spare = cash - buffer;

  // Buffer is short: raise cash from the sleeve first, so the sleeve can never
  // be the reason a real trade cannot be paid for.
  if (spare < 0 && sleeveQuantity > 0 && sleeveValue > 0) {
    const need = Math.max(-spare, minTicket);
    const quantity = Math.min(sleeveQuantity, Math.ceil(need / price));
    const notional = quantity * price;
    if (quantity < 1) return hold("Interest-fund holding is too small to raise cash from.");
    return {
      action: "sell",
      quantity,
      notional,
      reason: `Cash is £${cash.toFixed(0)} against a £${buffer.toFixed(0)} working buffer — selling £${notional.toFixed(0)} of the interest fund back into cash.`,
    };
  }

  if (spare < minTicket) {
    return hold(
      `Spare cash of £${Math.max(0, spare).toFixed(0)} above the £${buffer.toFixed(0)} buffer is too small to be worth a dealing charge.`,
    );
  }

  const quantity = Math.floor(spare / price);
  const notional = quantity * price;
  if (quantity < 1 || notional < minTicket) {
    return hold(`Spare cash of £${spare.toFixed(0)} does not buy a worthwhile amount of the interest fund.`);
  }

  const pctOfNav = nav > 0 ? (notional / nav) * 100 : 0;
  return {
    action: "buy",
    quantity,
    notional,
    reason: `£${notional.toFixed(0)} of cash (${pctOfNav.toFixed(0)}% of the account) is sitting idle above the £${buffer.toFixed(0)} buffer — moving it into the interest fund until it is needed.`,
  };
}
