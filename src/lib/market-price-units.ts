// Market-data price unit normalisation for order sizing and display.
//
// Yahoo Finance and Saxo both quote London Stock Exchange **common stocks**
// (e.g. HSBA.L) in GBX (pence). LSE-listed **ETFs** (VUKE.L, VMID.L, ISF.L,
// IUKD.L, VWRL.L, etc.), on the other hand, quote in GBP directly. Every
// numeric surface — order sizing, ledgers, per-position tiles — must convert
// GBX prices to GBP before mixing them with other GBP figures, or a single
// GBX-quoted row will dominate any total or largest-remainder allocation.

export function isLsePenceQuoted(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  return s.endsWith(".L") || s.endsWith(":XLON");
}

/**
 * True when this symbol's raw quote is in GBX (pence) for **display /
 * allocation** purposes — i.e. an LSE listing that is NOT an ETF. LSE ETFs
 * quote in GBP already, so their raw price must be left alone.
 *
 * `assetClass` comes from the `holdings.asset_class` column and, when
 * missing, we fall back to treating the symbol as pence-quoted (the
 * conservative assumption for LSE common stocks).
 */
export function isLseGbxDisplayQuoted(
  symbol: string,
  assetClass?: string | null,
): boolean {
  if (!isLsePenceQuoted(symbol)) return false;
  const ac = String(assetClass ?? "").toLowerCase();
  // LSE ETFs quote in GBP, not GBX.
  if (ac === "etf") return false;
  return true;
}

export function marketQuoteCurrency(symbol: string): "GBX" | null {
  return isLsePenceQuoted(symbol) ? "GBX" : null;
}

export function normalizeMarketPriceForTrading(symbol: string, price: number): number {
  if (!Number.isFinite(price)) return 0;
  return isLsePenceQuoted(symbol) ? price / 100 : price;
}

/**
 * Convert a native quote into the LSE base currency (GBP) for display and
 * for cross-position value aggregation. LSE ETFs are already in GBP and are
 * returned unchanged; LSE common stocks are divided by 100 to fold GBX
 * pence into pounds.
 */
export function normalizeLseDisplayPriceToBase(
  symbol: string,
  price: number,
  assetClass?: string | null,
): number {
  if (!Number.isFinite(price)) return 0;
  return isLseGbxDisplayQuoted(symbol, assetClass) ? price / 100 : price;
}
