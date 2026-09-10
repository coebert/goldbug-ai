/**
 * Simulation cost assumptions vs what the broker actually did.
 *
 * For each real order we compare two things against the backtest's model:
 *   fee  — what the simulation would have charged for the same ticket
 *          (commission, stamp, levy, spread, slippage, impact) against the
 *          fee the account actually paid (broker-invoiced where we have it,
 *          modelled where we do not).
 *   fill — the simulation assumes an order fills in full at the bar close;
 *          reality gives partial and unfilled orders. The fill rate is the
 *          share of the ordered quantity that actually traded.
 *
 * Everything here is pure: prices and fees arrive already converted to the
 * account currency and normalised for pence-quoted venues.
 */
import { roundMoney } from "./format-money";
import { priceTicket, type ExecutionAssumptions } from "./backtest/execution-assumptions";

export type CostGapFill = {
  quantity: number;
  /** Fill price in account currency. */
  priceBase: number;
  /** Fee actually charged for this fill, account currency, positive. */
  feeBase: number;
  feeSource: "broker" | "model" | "none";
  filledAt: string;
};

export type CostGapOrder = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  /** Quantity requested from the broker. */
  orderedQuantity: number;
  status: string;
  assetClass?: string | null;
  /** True when the ticket needed an FX funding leg. */
  foreign?: boolean;
  createdAt: string;
  fills: CostGapFill[];
};

export type CostGapRow = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  status: string;
  orderedQuantity: number;
  filledQuantity: number;
  /** 0–1. 1 means the simulation's full-fill assumption held. */
  fillRate: number;
  avgFillPriceBase: number | null;
  notionalBase: number;
  actualFeeBase: number;
  modelledFeeBase: number;
  /** Positive = the broker cost more than the simulation assumed. */
  feeGapBase: number;
  actualFeeBps: number;
  modelledFeeBps: number;
  feeGapBps: number;
  feeSource: "broker" | "model" | "mixed" | "none";
  filledAt: string | null;
  createdAt: string;
};

export type CostGapSummary = {
  orders: number;
  ordersWithFills: number;
  fullyFilled: number;
  partiallyFilled: number;
  unfilled: number;
  /** Filled quantity / ordered quantity across every order, 0–1. */
  fillRate: number;
  notionalBase: number;
  actualFeeBase: number;
  modelledFeeBase: number;
  feeGapBase: number;
  actualFeeBps: number;
  modelledFeeBps: number;
  feeGapBps: number;
  /** Share of measured fees that came from a real broker invoice, 0–1. */
  brokerBilledShare: number;
  /** Orders where the broker charged materially more than the model. */
  underModelled: number;
  /** Orders where the model over-charged relative to the broker. */
  overModelled: number;
};

export type CostModelGap = {
  rows: CostGapRow[];
  summary: CostGapSummary;
};

const bps = (value: number, notional: number) =>
  notional > 0 ? (value / notional) * 10_000 : 0;

const MATERIAL_GAP_BPS = 2;

function sourceOf(fills: CostGapFill[]): CostGapRow["feeSource"] {
  const kinds = new Set(fills.filter((f) => f.feeBase > 0).map((f) => f.feeSource));
  if (kinds.size === 0) return "none";
  if (kinds.size > 1) return "mixed";
  return [...kinds][0] as CostGapRow["feeSource"];
}

export function buildCostModelGap(
  orders: CostGapOrder[],
  assumptions: ExecutionAssumptions,
): CostModelGap {
  const rows: CostGapRow[] = [];

  for (const order of orders) {
    const fills = order.fills.filter((f) => f.quantity > 0 && f.priceBase > 0);
    const filledQuantity = fills.reduce((sum, f) => sum + f.quantity, 0);
    const notionalBase = fills.reduce((sum, f) => sum + f.quantity * f.priceBase, 0);
    const actualFeeBase = fills.reduce((sum, f) => sum + Math.abs(f.feeBase), 0);
    const avgFillPriceBase = filledQuantity > 0 ? notionalBase / filledQuantity : null;
    const ordered = Math.max(0, order.orderedQuantity);

    // Price the ticket the simulation's way: same symbol, side and traded
    // size, at the price we actually got.
    const modelledFeeBase =
      filledQuantity > 0 && avgFillPriceBase
        ? priceTicket(
            {
              symbol: order.symbol,
              side: order.side,
              quantity: filledQuantity,
              price: avgFillPriceBase,
              assetClass: order.assetClass ?? null,
              foreign: order.foreign ?? false,
            },
            assumptions,
          ).totalCost
        : 0;

    const feeGapBase = actualFeeBase - modelledFeeBase;
    const last = fills.length
      ? fills.reduce((a, b) => (a.filledAt > b.filledAt ? a : b)).filledAt
      : null;

    rows.push({
      id: order.id,
      symbol: order.symbol,
      side: order.side,
      status: order.status,
      orderedQuantity: ordered,
      filledQuantity,
      fillRate: ordered > 0 ? Math.min(1, filledQuantity / ordered) : filledQuantity > 0 ? 1 : 0,
      avgFillPriceBase,
      notionalBase: roundMoney(notionalBase),
      actualFeeBase: roundMoney(actualFeeBase),
      modelledFeeBase: roundMoney(modelledFeeBase),
      feeGapBase: roundMoney(feeGapBase),
      actualFeeBps: bps(actualFeeBase, notionalBase),
      modelledFeeBps: bps(modelledFeeBase, notionalBase),
      feeGapBps: bps(feeGapBase, notionalBase),
      feeSource: sourceOf(fills),
      filledAt: last,
      createdAt: order.createdAt,
    });
  }

  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const orderedTotal = rows.reduce((s, r) => s + r.orderedQuantity, 0);
  const filledTotal = rows.reduce((s, r) => s + r.filledQuantity, 0);
  const notionalBase = rows.reduce((s, r) => s + r.notionalBase, 0);
  const actualFeeBase = rows.reduce((s, r) => s + r.actualFeeBase, 0);
  const modelledFeeBase = rows.reduce((s, r) => s + r.modelledFeeBase, 0);
  const brokerFees = rows
    .filter((r) => r.feeSource === "broker")
    .reduce((s, r) => s + r.actualFeeBase, 0);
  const withFills = rows.filter((r) => r.filledQuantity > 0);

  const summary: CostGapSummary = {
    orders: rows.length,
    ordersWithFills: withFills.length,
    fullyFilled: rows.filter((r) => r.fillRate >= 0.999).length,
    partiallyFilled: rows.filter((r) => r.fillRate > 0 && r.fillRate < 0.999).length,
    unfilled: rows.filter((r) => r.filledQuantity <= 0).length,
    fillRate: orderedTotal > 0 ? Math.min(1, filledTotal / orderedTotal) : 0,
    notionalBase: roundMoney(notionalBase),
    actualFeeBase: roundMoney(actualFeeBase),
    modelledFeeBase: roundMoney(modelledFeeBase),
    feeGapBase: roundMoney(actualFeeBase - modelledFeeBase),
    actualFeeBps: bps(actualFeeBase, notionalBase),
    modelledFeeBps: bps(modelledFeeBase, notionalBase),
    feeGapBps: bps(actualFeeBase - modelledFeeBase, notionalBase),
    brokerBilledShare: actualFeeBase > 0 ? brokerFees / actualFeeBase : 0,
    underModelled: withFills.filter((r) => r.feeGapBps > MATERIAL_GAP_BPS).length,
    overModelled: withFills.filter((r) => r.feeGapBps < -MATERIAL_GAP_BPS).length,
  };

  return { rows, summary };
}
