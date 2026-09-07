import { roundMoney } from "./format-money";
import { engineSymbolKey } from "./price-symbol";

export type SymbolCashFlowFill = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  fillPriceBase: number;
  feeBase: number;
  feeSource: "broker" | "model" | "none";
};

export type SymbolCashFlowRow = {
  symbol: string;
  buyCash: number;
  sellCash: number;
  fees: number;
  brokerFees: number;
  estimatedFees: number;
  netCashUsed: number;
  fills: number;
  held: boolean;
};

export function buildSymbolCashFlow(
  fills: readonly SymbolCashFlowFill[],
  heldSymbols: ReadonlySet<string>,
): SymbolCashFlowRow[] {
  const rows = new Map<string, SymbolCashFlowRow>();

  for (const fill of fills) {
    const symbol = fill.symbol.trim();
    const quantity = Number(fill.quantity);
    const price = Number(fill.fillPriceBase);
    const fee = Math.max(0, Number(fill.feeBase) || 0);
    if (!symbol || !(quantity > 0) || !(price > 0)) continue;

    const current = rows.get(symbol) ?? {
      symbol,
      buyCash: 0,
      sellCash: 0,
      fees: 0,
      brokerFees: 0,
      estimatedFees: 0,
      netCashUsed: 0,
      fills: 0,
      held: heldSymbols.has(engineSymbolKey(symbol)),
    };
    const notional = quantity * price;
    if (fill.side === "sell") current.sellCash += notional;
    else current.buyCash += notional;
    current.fees += fee;
    if (fill.feeSource === "broker") current.brokerFees += fee;
    else current.estimatedFees += fee;
    current.fills += 1;
    rows.set(symbol, current);
  }

  return [...rows.values()]
    .map((row) => ({
      ...row,
      buyCash: roundMoney(row.buyCash),
      sellCash: roundMoney(row.sellCash),
      fees: roundMoney(row.fees),
      brokerFees: roundMoney(row.brokerFees),
      estimatedFees: roundMoney(row.estimatedFees),
      netCashUsed: roundMoney(row.buyCash + row.fees - row.sellCash),
    }))
    .sort((a, b) => Number(b.held) - Number(a.held) || b.netCashUsed - a.netCashUsed || a.symbol.localeCompare(b.symbol));
}