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
 * LSE tickers whose feed quotes arrive in **GBP (pounds)** rather than GBX.
 * This is a small, verified allowlist — the Vanguard UK range is quoted in
 * pounds by our price provider (VUKE ≈ 47.6, VMID ≈ 36.6), while the rest of
 * the LSE — including iShares ETFs such as ISF (≈ 1062) and SGLN (≈ 7690) —
 * arrives in pence.
 *
 * Do NOT widen this to "all ETFs": that rule inflated iShares positions by
 * 100x and made a simulated portfolio read ~9.2M instead of ~92k.
 */
const GBP_QUOTED_LSE_TICKERS = new Set([
  "VUKE", "VMID", "VUSA", "VWRL", "VHYL", "VEUR", "VJPN", "VFEM", "VEVE",
  "VAGP", "VGOV", "VERX", "VDPX", "VWRP", "VUAG",
]);

function lseRoot(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (s.endsWith(":XLON")) return s.slice(0, -5);
  if (s.endsWith(".L")) return s.slice(0, -2);
  return s;
}

/**
 * True when this symbol's raw quote is in GBX (pence). Applies to every LSE
 * listing except the explicitly GBP-quoted tickers above. `assetClass` is
 * accepted for backwards compatibility but no longer routes the decision —
 * ETF status alone does not imply a pound-denominated quote.
 */
export function isLseGbxDisplayQuoted(
  symbol: string,
  _assetClass?: string | null,
): boolean {
  if (!isLsePenceQuoted(symbol)) return false;
  return !GBP_QUOTED_LSE_TICKERS.has(lseRoot(symbol));
}

export function marketQuoteCurrency(symbol: string): "GBX" | null {
  return isLseGbxDisplayQuoted(symbol) ? "GBX" : null;
}

/** Order-sizing normalisation. Uses the same unit rule as display so the
 *  ledger and the tiles can never disagree about a symbol's scale. */
export function normalizeMarketPriceForTrading(symbol: string, price: number): number {
  if (!Number.isFinite(price)) return 0;
  return isLseGbxDisplayQuoted(symbol) ? price / 100 : price;
}

/**
 * Convert a native quote into the LSE base currency (GBP) for display and
 * for cross-position value aggregation. GBX quotes are divided by 100;
 * GBP-quoted LSE tickers and non-LSE symbols pass through unchanged.
 */
export function normalizeLseDisplayPriceToBase(
  symbol: string,
  price: number,
  assetClass?: string | null,
): number {
  if (!Number.isFinite(price)) return 0;
  return isLseGbxDisplayQuoted(symbol, assetClass) ? price / 100 : price;
}

/**
 * Cost basis stored on `holdings.avg_cost` is ALREADY in the portfolio's base
 * currency: every writer (`live-holdings-sync`, `fills-trades-reconcile`,
 * the ledger rebuild) normalises broker GBX into GBP before persisting.
 *
 * Read paths must therefore NOT normalise again — doing so divides an LSE
 * cost basis by 100 a second time (MKS £4.04 → "GBP 0.04") and reports
 * absurd gains such as +9900%. Use this helper on every read so the rule is
 * stated in exactly one place.
 */
export function holdingAvgCostBase(
  _symbol: string,
  avgCost: number | string | null | undefined,
): number {
  const n = Number(avgCost);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Inverse of `normalizeMarketPriceForTrading`: take a price already
 * normalised into the base currency (GBP) and express it back in the
 * instrument's **native quote units** before sending it to the broker.
 *
 * Saxo quotes LSE common stocks in GBX, so a limit price of 4.05 (GBP) on
 * MKS:xlon sits ~100x below the ~404p market and the venue rejects the
 * order with "Price exceeds aggressive tolerance". Every broker-bound
 * price must pass through here.
 */
export function denormalizePriceToQuoteUnits(symbol: string, price: number): number {
  if (!Number.isFinite(price)) return 0;
  return isLseGbxDisplayQuoted(symbol) ? price * 100 : price;
}

/**
 * Broker-bound price in the instrument's native quote units, using both the
 * symbol rule and the broker's own quote currency.
 *
 * Saxo reports `GBX` on many LSE listings, including ones our symbol rule
 * can't classify (a bare `MKS` with no venue suffix, secondary listings).
 * Either signal saying "pence" is enough; a GBP-quoted LSE ETF passes
 * through untouched because neither signal fires.
 */
export function nativeQuotePrice(
  symbol: string,
  price: number,
  brokerCurrency?: string | null,
): number {
  if (!Number.isFinite(price)) return 0;
  const bySymbol = denormalizePriceToQuoteUnits(symbol, price);
  if (bySymbol !== price) return bySymbol;
  const ccy = String(brokerCurrency ?? "").trim().toUpperCase();
  return ccy === "GBX" ? price * 100 : price;
}


