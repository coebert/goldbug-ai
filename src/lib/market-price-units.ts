// Market-data price unit normalisation for order sizing.
//
// Yahoo Finance quotes London-listed `.L` instruments in GBX (pence), while
// Saxo order placement, commission floors, broker cash, and portfolio ledgers
// use GBP. The trading engine must therefore convert LSE market prices from
// pence to pounds before sizing quantity/notional for broker-routed orders.

export function isLsePenceQuoted(symbol: string): boolean {
  return symbol.trim().toUpperCase().endsWith(".L");
}

export function marketQuoteCurrency(symbol: string): "GBX" | null {
  return isLsePenceQuoted(symbol) ? "GBX" : null;
}

export function normalizeMarketPriceForTrading(symbol: string, price: number): number {
  if (!Number.isFinite(price)) return 0;
  return isLsePenceQuoted(symbol) ? price / 100 : price;
}
