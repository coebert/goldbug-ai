// Shared mapping between broker-native holding symbols ("MKS:xlon") and the
// Yahoo-style keys used by `price_cache` ("MKS.L").
//
// Getting this wrong is not a cosmetic bug: when a lookup misses, valuation
// code silently falls back to `avg_cost`, and for LSE rows that cost basis is
// stored in GBX (pence) — producing a 100x inflated portfolio value.

const MIC_TO_YAHOO: Record<string, string> = {
  xlon: "L", xetr: "DE", xpar: "PA", xams: "AS", xmil: "MI",
  xmad: "MC", xswx: "SW", xtse: "TO", xhkg: "HK", xtks: "T",
  xasx: "AX", xsto: "ST", xcse: "CO", xhel: "HE", xose: "OL",
  xnas: "", xnys: "", arcx: "", bats: "",
};

/**
 * Retired listings that still sit in holdings, watches and older config.
 * Yahoo 404s on them forever, which silently pins the whole symbol to a stale
 * cached close, so map them onto the live successor ETP before any fetch.
 */
const RETIRED_SYMBOL_ALIASES: Record<string, string> = {
  "ETHE.DE": "ZETH.DE", // ETC Group Physical Ethereum relisted as ZETH.DE
  "VBTC.L": "BTCW.L",   // WisdomTree Physical Bitcoin LSE line is BTCW.L
};

/** Live replacement for a retired ticker, or the symbol unchanged. */
export function resolveRetiredSymbol(symbol: string): string {
  const s = String(symbol ?? "").trim().toUpperCase();
  return RETIRED_SYMBOL_ALIASES[s] ?? String(symbol ?? "").trim();
}

/** "MKS:xlon" → "MKS.L", "AAPL:xnas" → "AAPL", others unchanged. */
export function resolvePriceSymbol(symbol: string): string {
  const sym = resolveRetiredSymbol(symbol);
  const colon = sym.lastIndexOf(":");
  if (colon < 0) return sym;
  const base = sym.slice(0, colon);
  const mic = sym.slice(colon + 1).toLowerCase();
  const yahoo = MIC_TO_YAHOO[mic];
  if (yahoo == null) return sym;
  return resolveRetiredSymbol(yahoo ? `${base}.${yahoo}` : base);
}

/**
 * All uppercase keys a price row might be stored under for this holding,
 * most specific first. Used both to widen the `price_cache` query and to
 * look a price up once loaded.
 */
export function priceSymbolVariants(symbol: string): string[] {
  const sym = String(symbol ?? "").trim();
  if (!sym) return [];
  const out = new Set<string>();
  out.add(sym.toUpperCase());
  out.add(resolvePriceSymbol(sym).toUpperCase());
  return [...out].filter(Boolean);
}

/**
 * Canonical key used to match a stored holding against the trading universe,
 * priceMap and AI order symbols. Broker-native holdings arrive as
 * "AAPL:xnas" / "MKS:xlon" while orders and prices use "AAPL" / "MKS.L";
 * keying on the raw broker symbol made every sell path miss the position.
 */
export function engineSymbolKey(symbol: string): string {
  return resolvePriceSymbol(String(symbol ?? "")).toUpperCase();
}
