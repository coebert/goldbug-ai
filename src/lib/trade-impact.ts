/**
 * Per-trade money impact for the live account.
 *
 * Takes real fills (already converted to the account currency) in time order
 * and works out, for each one: how much cash it moved, what it cost in fees,
 * the profit it locked in (sells, average-cost basis), and the running cash
 * and profit position after it. Marks-to-market whatever is still held.
 */
import { roundMoney } from "./format-money";

export type TradeImpactFill = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  /** Fill price in account currency. */
  priceBase: number;
  /** Fee in account currency, always positive. */
  feeBase: number;
  feeSource: "broker" | "model" | "none";
  filledAt: string;
};

export type TradeImpactRow = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  priceBase: number;
  grossBase: number;
  feeBase: number;
  feeSource: "broker" | "model" | "none";
  /** Negative on buys (cash out), positive on sells (cash in), fees included. */
  cashDeltaBase: number;
  /** Profit locked in by this sell, net of this ticket's fee. Null on buys. */
  realisedBase: number | null;
  /** Cumulative net cash moved by trades up to and including this one. */
  runningCashBase: number;
  /** Cumulative realised profit net of all fees up to and including this one. */
  runningRealisedBase: number;
  /** Position in this symbol after the fill. */
  positionAfter: number;
  filledAt: string;
};

export type TradeImpactOpenPosition = {
  symbol: string;
  quantity: number;
  avgCostBase: number;
  markBase: number | null;
  costBase: number;
  valueBase: number | null;
  unrealisedBase: number | null;
};

export type TradeImpactSummary = {
  trades: number;
  cashOutBase: number;
  cashInBase: number;
  netCashBase: number;
  feesBase: number;
  brokerFeesBase: number;
  estimatedFeesBase: number;
  realisedBase: number;
  unrealisedBase: number;
  totalProfitBase: number;
};

export type TradeImpact = {
  rows: TradeImpactRow[];
  open: TradeImpactOpenPosition[];
  summary: TradeImpactSummary;
};

type Lot = { quantity: number; cost: number };

/**
 * @param fills chronological (oldest first) real fills
 * @param marks latest price per symbol in account currency, when known
 */
export function buildTradeImpact(
  fills: readonly TradeImpactFill[],
  marks: ReadonlyMap<string, number>,
): TradeImpact {
  const lots = new Map<string, Lot>();
  const rows: TradeImpactRow[] = [];
  let runningCash = 0;
  let runningRealised = 0;
  let feesTotal = 0;
  let brokerFees = 0;
  let estimatedFees = 0;
  let cashOut = 0;
  let cashIn = 0;

  for (const fill of fills) {
    const quantity = Number(fill.quantity);
    const price = Number(fill.priceBase);
    if (!(quantity > 0) || !(price > 0)) continue;
    const fee = Math.max(0, Number(fill.feeBase) || 0);
    const gross = quantity * price;
    const lot = lots.get(fill.symbol) ?? { quantity: 0, cost: 0 };

    let realised: number | null = null;
    let cashDelta: number;
    if (fill.side === "sell") {
      const sold = Math.min(quantity, lot.quantity);
      const basis = lot.quantity > 0 ? (lot.cost / lot.quantity) * sold : 0;
      realised = gross - basis - fee;
      lot.quantity = Math.max(0, lot.quantity - quantity);
      lot.cost = lot.quantity > 0 ? Math.max(0, lot.cost - basis) : 0;
      cashDelta = gross - fee;
      cashIn += cashDelta;
      runningRealised += realised;
    } else {
      lot.quantity += quantity;
      lot.cost += gross + fee;
      cashDelta = -(gross + fee);
      cashOut += gross + fee;
    }
    lots.set(fill.symbol, lot);

    feesTotal += fee;
    if (fill.feeSource === "broker") brokerFees += fee;
    else estimatedFees += fee;
    runningCash += cashDelta;

    rows.push({
      id: fill.id,
      symbol: fill.symbol,
      side: fill.side,
      quantity,
      priceBase: price,
      grossBase: roundMoney(gross),
      feeBase: roundMoney(fee),
      feeSource: fill.feeSource,
      cashDeltaBase: roundMoney(cashDelta),
      realisedBase: realised == null ? null : roundMoney(realised),
      runningCashBase: roundMoney(runningCash),
      runningRealisedBase: roundMoney(runningRealised),
      positionAfter: lot.quantity,
      filledAt: fill.filledAt,
    });
  }

  const open: TradeImpactOpenPosition[] = [];
  let unrealised = 0;
  for (const [symbol, lot] of lots) {
    if (!(lot.quantity > 0)) continue;
    const mark = marks.get(symbol);
    const value = mark != null && mark > 0 ? lot.quantity * mark : null;
    const gain = value == null ? null : value - lot.cost;
    if (gain != null) unrealised += gain;
    open.push({
      symbol,
      quantity: lot.quantity,
      avgCostBase: roundMoney(lot.cost / lot.quantity),
      markBase: mark != null && mark > 0 ? mark : null,
      costBase: roundMoney(lot.cost),
      valueBase: value == null ? null : roundMoney(value),
      unrealisedBase: gain == null ? null : roundMoney(gain),
    });
  }
  open.sort((a, b) => (b.valueBase ?? 0) - (a.valueBase ?? 0) || a.symbol.localeCompare(b.symbol));

  return {
    rows,
    open,
    summary: {
      trades: rows.length,
      cashOutBase: roundMoney(cashOut),
      cashInBase: roundMoney(cashIn),
      netCashBase: roundMoney(runningCash),
      feesBase: roundMoney(feesTotal),
      brokerFeesBase: roundMoney(brokerFees),
      estimatedFeesBase: roundMoney(estimatedFees),
      realisedBase: roundMoney(runningRealised),
      unrealisedBase: roundMoney(unrealised),
      totalProfitBase: roundMoney(runningRealised + unrealised),
    },
  };
}
