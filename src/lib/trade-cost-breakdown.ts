/**
 * Per-trade dealing-cost breakdown with the cash left after each ticket.
 *
 * The trade-impact panel answers "what did this trade do to my money"; this
 * answers "what did the dealing itself cost, line by line, and how much cash
 * was left standing afterwards". Charges are split into commission, tax
 * (stamp duty), exchange/regulator levies and anything else the broker billed,
 * so an expensive ticket can be blamed on the right line.
 *
 * Cash left is walked *backwards* from today's known balance: the last trade
 * leaves today's cash, and each earlier trade leaves whatever came after it
 * undone. Deposits and currency legs between trades are not trade cash, so the
 * further back a row sits the more it is an estimate — the caller labels it so.
 *
 * Pure: no IO, no broker, no database.
 */
import { roundMoney } from "./format-money";

export type TradeCostFill = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  /** Fill price in account currency. */
  priceBase: number;
  /** Total charge in account currency, always positive. */
  feeBase: number;
  /** Charge lines in account currency; may be absent when the broker only sent a total. */
  commissionBase?: number | null;
  taxBase?: number | null;
  exchangeBase?: number | null;
  otherBase?: number | null;
  feeSource: "broker" | "model" | "none";
  filledAt: string;
};

export type TradeCostRow = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  priceBase: number;
  /** Quantity x price, before charges. */
  grossBase: number;
  commissionBase: number;
  taxBase: number;
  exchangeBase: number;
  otherBase: number;
  /** Sum of the lines; equals the broker/model total. */
  totalCostBase: number;
  /** Total charge as basis points of the ticket's gross value. */
  costBps: number;
  /** True when the lines came itemised rather than lumped into "other". */
  itemised: boolean;
  feeSource: "broker" | "model" | "none";
  /** Cash the ticket moved, charges included: negative on buys. */
  cashDeltaBase: number;
  /** Account cash after this ticket settled. */
  cashLeftBase: number;
  filledAt: string;
};

export type TradeCostSummary = {
  trades: number;
  grossBase: number;
  commissionBase: number;
  taxBase: number;
  exchangeBase: number;
  otherBase: number;
  totalCostBase: number;
  /** Charges as bps of everything traded. */
  costBps: number;
  brokerBilledBase: number;
  estimatedBase: number;
  /** Most expensive ticket by bps, when there is one. */
  worst: { symbol: string; costBps: number; totalCostBase: number } | null;
  cashLeftBase: number;
};

export type TradeCostBreakdown = {
  rows: TradeCostRow[];
  summary: TradeCostSummary;
};

function pos(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * @param fills chronological (oldest first) real fills, account currency
 * @param cashNowBase the account's cash balance today, account currency
 */
export function buildTradeCostBreakdown(
  fills: readonly TradeCostFill[],
  cashNowBase: number,
): TradeCostBreakdown {
  const usable = fills.filter((f) => pos(f.quantity) > 0 && pos(f.priceBase) > 0);

  const priced = usable.map((fill) => {
    const quantity = Number(fill.quantity);
    const price = Number(fill.priceBase);
    const gross = quantity * price;
    const total = Math.max(0, Number(fill.feeBase) || 0);

    const commission = pos(fill.commissionBase);
    const tax = pos(fill.taxBase);
    const exchange = pos(fill.exchangeBase);
    const namedOther = pos(fill.otherBase);
    const named = commission + tax + exchange + namedOther;
    // Anything the total carries beyond the named lines is unexplained charge;
    // never hide it, and never let rounding invent a negative line.
    const other = Math.max(0, namedOther + (total - named));
    const itemised = commission + tax + exchange > 0;

    const cashDelta = fill.side === "sell" ? gross - total : -(gross + total);
    return { fill, quantity, price, gross, total, commission, tax, exchange, other, itemised, cashDelta };
  });

  // Walk back from today's cash so the newest row is exact.
  const cashLeft: number[] = new Array(priced.length).fill(0);
  let running = Number.isFinite(cashNowBase) ? Number(cashNowBase) : 0;
  for (let i = priced.length - 1; i >= 0; i -= 1) {
    cashLeft[i] = running;
    running -= priced[i]!.cashDelta;
  }

  const rows: TradeCostRow[] = priced.map((p, i) => ({
    id: p.fill.id,
    symbol: p.fill.symbol,
    side: p.fill.side,
    quantity: p.quantity,
    priceBase: p.price,
    grossBase: roundMoney(p.gross),
    commissionBase: roundMoney(p.commission),
    taxBase: roundMoney(p.tax),
    exchangeBase: roundMoney(p.exchange),
    otherBase: roundMoney(p.other),
    totalCostBase: roundMoney(p.total),
    costBps: p.gross > 0 ? (p.total / p.gross) * 10_000 : 0,
    itemised: p.itemised,
    feeSource: p.fill.feeSource,
    cashDeltaBase: roundMoney(p.cashDelta),
    cashLeftBase: roundMoney(cashLeft[i] ?? 0),
    filledAt: p.fill.filledAt,
  }));

  let gross = 0;
  let commission = 0;
  let tax = 0;
  let exchange = 0;
  let other = 0;
  let total = 0;
  let broker = 0;
  let estimated = 0;
  let worst: TradeCostSummary["worst"] = null;
  for (const r of rows) {
    gross += r.grossBase;
    commission += r.commissionBase;
    tax += r.taxBase;
    exchange += r.exchangeBase;
    other += r.otherBase;
    total += r.totalCostBase;
    if (r.feeSource === "broker") broker += r.totalCostBase;
    else estimated += r.totalCostBase;
    if (r.totalCostBase > 0 && (worst == null || r.costBps > worst.costBps)) {
      worst = { symbol: r.symbol, costBps: r.costBps, totalCostBase: r.totalCostBase };
    }
  }

  return {
    rows,
    summary: {
      trades: rows.length,
      grossBase: roundMoney(gross),
      commissionBase: roundMoney(commission),
      taxBase: roundMoney(tax),
      exchangeBase: roundMoney(exchange),
      otherBase: roundMoney(other),
      totalCostBase: roundMoney(total),
      costBps: gross > 0 ? (total / gross) * 10_000 : 0,
      brokerBilledBase: roundMoney(broker),
      estimatedBase: roundMoney(estimated),
      worst,
      cashLeftBase: roundMoney(Number.isFinite(cashNowBase) ? Number(cashNowBase) : 0),
    },
  };
}
