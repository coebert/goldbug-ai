export type WorkingSellOrder = {
  brokerOrderId: string;
  symbol: string;
  buySell?: "Buy" | "Sell";
  filledAmount: number;
  amount: number;
  orderTime?: string;
};

function baseTicker(symbol: string): string {
  const upper = String(symbol ?? "").trim().toUpperCase();
  const colon = upper.indexOf(":");
  const withoutVenue = colon >= 0 ? upper.slice(0, colon) : upper;
  const dot = withoutVenue.lastIndexOf(".");
  return dot > 0 ? withoutVenue.slice(0, dot) : withoutVenue;
}

/**
 * A marketable sell limit is a short-lived execution cap, not a price target.
 * Once it has rested for several minutes it can be far above a falling market
 * and block every replacement as a duplicate broker order. Return only an
 * aged, still-open sell for the same instrument; fresh orders are left alone.
 */
export function findStaleWorkingSell(args: {
  working: WorkingSellOrder[];
  symbol: string;
  nowMs?: number;
  maxAgeMs?: number;
}): WorkingSellOrder | null {
  const nowMs = args.nowMs ?? Date.now();
  const maxAgeMs = args.maxAgeMs ?? 5 * 60_000;
  const wanted = baseTicker(args.symbol);
  if (!wanted) return null;

  return args.working.find((order) => {
    if (order.buySell !== "Sell" || baseTicker(order.symbol) !== wanted) return false;
    if (!(order.amount - order.filledAmount > 0)) return false;
    const placedMs = Date.parse(String(order.orderTime ?? ""));
    return Number.isFinite(placedMs) && nowMs - placedMs >= maxAgeMs;
  }) ?? null;
}