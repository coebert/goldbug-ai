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

/** "MKS:xlon" → "MKS.L", "AAPL:xnas" → "AAPL", others unchanged. */
export function resolvePriceSymbol(symbol: string): string {
  const sym = String(symbol ?? "").trim();
  const colon = sym.lastIndexOf(":");
  if (colon < 0) return sym;
  const base = sym.slice(0, colon);
  const mic = sym.slice(colon + 1).toLowerCase();
  const yahoo = MIC_TO_YAHOO[mic];
  if (yahoo == null) return sym;
  return yahoo ? `${base}.${yahoo}` : base;
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
