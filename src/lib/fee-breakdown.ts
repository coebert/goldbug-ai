// Pure helpers that compute Saxo-fee breakdown for a set of trades.
// Consumed by src/lib/fee-breakdown.functions.ts (server) and rendered by
// src/components/fee-breakdown-card.tsx.
//
// The two things this module answers:
//   1) How much are we paying in commissions across every trade in the window?
//      (per-trade estimate via estimateSaxoCommission, then aggregated as an
//      annualised bps drag over turnover.)
//   2) What did each realized round-trip actually net after buy+sell fees?
//      (FIFO lot matching identical to backtest-metrics; buy fees are
//      allocated pro-rata by the quantity taken out of each lot.)

import {
  estimateSaxoCommission,
  inferSaxoCurrency,
  type AssetClass,
} from "./saxo-fees";

export type FeeTradeInput = {
  trade_date: string;
  executed_at?: string | null;
  side: "buy" | "sell";
  symbol: string;
  quantity: number;
  price: number;
  /** Trade currency; falls back to inferSaxoCurrency(symbol) when absent. */
  instrument_ccy?: string | null;
  asset_class?: string | null;
};

export type PerTradeFeeRow = {
  trade_date: string;
  executed_at: string | null;
  side: "buy" | "sell";
  symbol: string;
  quantity: number;
  price: number;
  notional: number;
  currency: string;
  commission: number;
  perSideBps: number;
  /** True when Saxo's min-commission floor set the fee (headline % missed). */
  minFloorApplied: boolean;
};

export type RoundTripFeeRow = {
  symbol: string;
  currency: string;
  buyDate: string;
  sellDate: string;
  quantity: number;
  buyPrice: number;
  sellPrice: number;
  buyNotional: number;
  sellNotional: number;
  buyFee: number;
  sellFee: number;
  totalFee: number;
  grossPnl: number;
  netPnl: number;
  /** Net return = netPnl / buyNotional × 100 (percent). */
  netReturnPct: number;
  /** Fee drag = totalFee / avg(buyNotional, sellNotional) × 10000 (bps). */
  feeDragBps: number;
};

export type FeeBreakdownSummary = {
  currency: string;
  tradeCount: number;
  totalBuyNotional: number;
  totalSellNotional: number;
  totalTurnover: number;
  totalCommissions: number;
  /** Overall drag = totalCommissions / totalTurnover × 10000 (bps). */
  overallFeeDragBps: number;
  minFloorTradeCount: number;
  /** Round-trip aggregates (closed FIFO lots only). */
  closedRoundTrips: number;
  closedGrossPnl: number;
  closedNetPnl: number;
  closedFees: number;
  /** Net vs gross drag on closed lots: (gross - net) / |gross| × 100. */
  closedNetVsGrossPct: number | null;
};

export type FeeBreakdown = {
  summary: FeeBreakdownSummary;
  perTrade: PerTradeFeeRow[];
  roundTrips: RoundTripFeeRow[];
};

type Lot = {
  originalQty: number;
  remainingQty: number;
  price: number;
  fee: number;
  date: string;
  currency: string;
};

/**
 * Compute per-trade commissions and per-round-trip net returns for the given
 * trades. Trades are sorted by (trade_date, executed_at) so the FIFO matcher
 * mirrors backtest-metrics.realizedPnlPerRoundTrip.
 *
 * `displayCurrency` is used only for the summary line — per-trade rows keep
 * their own trade currency. If different currencies are mixed and none is
 * passed in we surface the first trade's currency for the label; totals are
 * still summed as-is (callers that need FX-normalised totals should compose
 * on top).
 */
export function computeFeeBreakdown(
  trades: FeeTradeInput[],
  displayCurrency?: string,
): FeeBreakdown {
  const sorted = [...trades].sort((a, b) => {
    if (a.trade_date !== b.trade_date) return a.trade_date.localeCompare(b.trade_date);
    return (a.executed_at ?? "").localeCompare(b.executed_at ?? "");
  });

  const perTrade: PerTradeFeeRow[] = [];
  const roundTrips: RoundTripFeeRow[] = [];
  const lots = new Map<string, Lot[]>();

  let totalBuyNotional = 0;
  let totalSellNotional = 0;
  let totalCommissions = 0;
  let minFloorCount = 0;
  let closedGross = 0;
  let closedNet = 0;
  let closedFees = 0;

  for (const t of sorted) {
    const qty = Number(t.quantity);
    const price = Number(t.price);
    if (!Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0 || price <= 0) continue;

    const notional = qty * price;
    const currency = (t.instrument_ccy ?? inferSaxoCurrency(t.symbol)).toUpperCase();
    const est = estimateSaxoCommission({
      notional,
      currency,
      symbol: t.symbol,
      assetClass: (t.asset_class ?? undefined) as AssetClass | undefined,
    });

    perTrade.push({
      trade_date: t.trade_date,
      executed_at: t.executed_at ?? null,
      side: t.side,
      symbol: t.symbol,
      quantity: qty,
      price,
      notional,
      currency,
      commission: est.commission,
      perSideBps: est.perSideBps,
      minFloorApplied: est.minFloorApplied,
    });
    totalCommissions += est.commission;
    if (est.minFloorApplied) minFloorCount += 1;

    const bucket = lots.get(t.symbol) ?? [];
    if (t.side === "buy") {
      totalBuyNotional += notional;
      bucket.push({
        originalQty: qty,
        remainingQty: qty,
        price,
        fee: est.commission,
        date: t.trade_date,
        currency,
      });
      lots.set(t.symbol, bucket);
      continue;
    }

    // sell: consume oldest lots first, allocating buy fee pro-rata by qty.
    totalSellNotional += notional;
    let remaining = qty;
    const sellFeeTotal = est.commission;
    // We split the sell's commission across the matched lots by quantity too,
    // so partial-fill round-trips carry their fair share.
    const totalMatchable = Math.min(qty, bucket.reduce((a, l) => a + l.remainingQty, 0));
    while (remaining > 0 && bucket.length > 0) {
      const lot = bucket[0];
      const take = Math.min(lot.remainingQty, remaining);
      const buyFeeShare = lot.originalQty > 0 ? (lot.fee * take) / lot.originalQty : 0;
      const sellFeeShare = totalMatchable > 0 ? (sellFeeTotal * take) / totalMatchable : 0;
      const gross = (price - lot.price) * take;
      const totalFee = buyFeeShare + sellFeeShare;
      const net = gross - totalFee;
      const buyNotional = lot.price * take;
      const sellNotional = price * take;
      roundTrips.push({
        symbol: t.symbol,
        currency: lot.currency,
        buyDate: lot.date,
        sellDate: t.trade_date,
        quantity: take,
        buyPrice: lot.price,
        sellPrice: price,
        buyNotional,
        sellNotional,
        buyFee: buyFeeShare,
        sellFee: sellFeeShare,
        totalFee,
        grossPnl: gross,
        netPnl: net,
        netReturnPct: buyNotional > 0 ? (net / buyNotional) * 100 : 0,
        feeDragBps:
          buyNotional + sellNotional > 0
            ? (totalFee / ((buyNotional + sellNotional) / 2)) * 10_000
            : 0,
      });
      closedGross += gross;
      closedNet += net;
      closedFees += totalFee;
      lot.remainingQty -= take;
      remaining -= take;
      if (lot.remainingQty <= 1e-9) bucket.shift();
    }
    lots.set(t.symbol, bucket);
  }

  const totalTurnover = totalBuyNotional + totalSellNotional;
  const summary: FeeBreakdownSummary = {
    currency:
      displayCurrency
      ?? perTrade[0]?.currency
      ?? "USD",
    tradeCount: perTrade.length,
    totalBuyNotional,
    totalSellNotional,
    totalTurnover,
    totalCommissions,
    overallFeeDragBps:
      totalTurnover > 0 ? (totalCommissions / totalTurnover) * 10_000 : 0,
    minFloorTradeCount: minFloorCount,
    closedRoundTrips: roundTrips.length,
    closedGrossPnl: closedGross,
    closedNetPnl: closedNet,
    closedFees: closedFees,
    closedNetVsGrossPct:
      Math.abs(closedGross) > 1e-9 ? ((closedGross - closedNet) / Math.abs(closedGross)) * 100 : null,
  };

  return { summary, perTrade, roundTrips };
}
