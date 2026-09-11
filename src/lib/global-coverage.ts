import { roundMoney } from "./format-money";

export type CoverageSuggestion = {
  id: string;
  symbol: string;
  name: string | null;
  market: string;
  marketLabel: string;
  suggestedAt: string;
  quantity: number;
  conviction: number;
  expectedEdgeBps: number;
  expectedProfitBase: number;
  suggestedPrice: number;
  costBase: number;
  fxToBase: number;
  recommended: boolean;
  blockedReason: string | null;
};

export type CoverageOrder = {
  id: string;
  symbol: string;
  quantity: number;
  status: string;
  reason: string | null;
  createdAt: string;
};

export type CoverageFill = { orderId: string; symbol: string; quantity: number; filledAt: string };

export type MissReason = "blocked" | "rejected" | "cancelled" | "no_order" | "pending";

export type CoverageSignalRow = CoverageSuggestion & {
  filledQuantity: number;
  fillRate: number;
  status: "filled" | "partial" | "missed" | "pending";
  missReason: MissReason | null;
  reasonLabel: string | null;
  moveBps: number | null;
  missedOutcomeBase: number | null;
};

export type CoverageMarketGroup = {
  market: string;
  label: string;
  suggestions: number;
  full: number;
  partial: number;
  missed: number;
  pending: number;
  fillRate: number;
  averageConfidence: number | null;
  averageExpectedEdgeBps: number | null;
  missedProfitBase: number;
  rows: CoverageSignalRow[];
};

export type GlobalCoverage = {
  portfolioId: string;
  portfolioName: string;
  currency: string;
  days: number;
  suggestions: number;
  filled: number;
  missed: number;
  pending: number;
  fillRate: number;
  missedProfitBase: number;
  groups: CoverageMarketGroup[];
};

const DAY = 86_400_000;
const average = (xs: number[]) => xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : null;

export function buildGlobalCoverage(args: {
  suggestions: CoverageSuggestion[];
  orders: CoverageOrder[];
  fills: CoverageFill[];
  pricesNow: Record<string, number>;
  now: Date;
  matchWindowDays?: number;
}): { groups: CoverageMarketGroup[]; rows: CoverageSignalRow[] } {
  const windowMs = (args.matchWindowDays ?? 3) * DAY;
  const claimedFills = new Set<number>();
  const claimedOrders = new Set<string>();
  const suggestions = [...args.suggestions].sort((a, b) => Date.parse(a.suggestedAt) - Date.parse(b.suggestedAt));
  const rows = suggestions.map((suggestion): CoverageSignalRow => {
    const start = Date.parse(suggestion.suggestedAt);
    const end = start + windowMs;
    const matchingOrders = args.orders.filter((order) => !claimedOrders.has(order.id) && order.symbol === suggestion.symbol && Date.parse(order.createdAt) >= start - 3_600_000 && Date.parse(order.createdAt) <= end);
    for (const order of matchingOrders) claimedOrders.add(order.id);
    const orderIds = new Set(matchingOrders.map((order) => order.id));
    const matchingFills = args.fills.filter((fill, index) => {
      if (claimedFills.has(index) || fill.symbol !== suggestion.symbol) return false;
      const at = Date.parse(fill.filledAt);
      return (orderIds.has(fill.orderId) || (at >= start - 3_600_000 && at <= end));
    });
    for (const fill of matchingFills) claimedFills.add(args.fills.indexOf(fill));
    const filledQuantity = matchingFills.reduce((sum, fill) => sum + fill.quantity, 0);
    const fillRate = suggestion.quantity > 0 ? Math.min(1, filledQuantity / suggestion.quantity) : filledQuantity > 0 ? 1 : 0;
    const expired = args.now.getTime() > end;
    const terminalOrder = [...matchingOrders].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
    let status: CoverageSignalRow["status"] = fillRate >= 0.999 ? "filled" : fillRate > 0 ? "partial" : expired ? "missed" : "pending";
    let missReason: MissReason | null = null;
    let reasonLabel: string | null = null;
    if (status === "missed") {
      const state = terminalOrder?.status.toLowerCase() ?? "";
      if (suggestion.blockedReason) { missReason = "blocked"; reasonLabel = suggestion.blockedReason; }
      else if (state.includes("reject") || state === "error") { missReason = "rejected"; reasonLabel = terminalOrder?.reason ?? "Broker rejected the order"; }
      else if (state.includes("cancel")) { missReason = "cancelled"; reasonLabel = terminalOrder?.reason ?? "Order expired or was cancelled without a fill"; }
      else { missReason = "no_order"; reasonLabel = terminalOrder?.reason ?? "No matching buy reached the broker"; }
    } else if (status === "pending") {
      missReason = "pending";
      reasonLabel = terminalOrder ? "Still inside the three-day fill window" : "Still eligible to trade";
    }
    const current = args.pricesNow[suggestion.symbol];
    const moveBps = Number.isFinite(current) && current > 0 && suggestion.suggestedPrice > 0 ? ((current - suggestion.suggestedPrice) / suggestion.suggestedPrice) * 10_000 : null;
    const missedOutcomeBase = status === "missed" && moveBps != null
      ? roundMoney((current - suggestion.suggestedPrice) * suggestion.quantity * suggestion.fxToBase - suggestion.costBase)
      : null;
    return { ...suggestion, filledQuantity, fillRate, status, missReason, reasonLabel, moveBps, missedOutcomeBase };
  });

  const markets = new Map<string, CoverageSignalRow[]>();
  for (const row of rows) markets.set(row.market, [...(markets.get(row.market) ?? []), row]);
  const groups = [...markets.entries()].map(([market, marketRows]): CoverageMarketGroup => {
    const quantity = marketRows.reduce((sum, row) => sum + Math.max(0, row.quantity), 0);
    const filled = marketRows.reduce((sum, row) => sum + row.filledQuantity, 0);
    return {
      market,
      label: marketRows[0]?.marketLabel ?? market,
      suggestions: marketRows.length,
      full: marketRows.filter((row) => row.status === "filled").length,
      partial: marketRows.filter((row) => row.status === "partial").length,
      missed: marketRows.filter((row) => row.status === "missed").length,
      pending: marketRows.filter((row) => row.status === "pending").length,
      fillRate: quantity > 0 ? Math.min(1, filled / quantity) : 0,
      averageConfidence: average(marketRows.map((row) => row.conviction).filter(Number.isFinite)),
      averageExpectedEdgeBps: average(marketRows.map((row) => row.expectedEdgeBps).filter(Number.isFinite)),
      missedProfitBase: roundMoney(marketRows.reduce((sum, row) => sum + (row.missedOutcomeBase ?? 0), 0)),
      rows: [...marketRows].sort((a, b) => b.suggestedAt.localeCompare(a.suggestedAt)),
    };
  }).sort((a, b) => a.fillRate - b.fillRate || b.suggestions - a.suggestions);
  return { groups, rows };
}