// Shared classifier that buckets a crypto ETP/ETN symbol into a human group.
// Structure mirrors `commodity-groups.ts` so the exposure card, engine risk
// caps and prompt stay in sync.
//
// Scope is deliberately narrow: Saxo-tradable, physically-backed crypto
// exchange-traded products only. No spot BTC/ETH, no futures, no leverage,
// no single-miner or crypto-exchange equities used as a proxy.

export type CryptoGroup = "BTC" | "ETH" | "Basket";

export const CRYPTO_GROUPS: CryptoGroup[] = ["BTC", "ETH", "Basket"];

export const CRYPTO_SYMBOL_MAP: Record<string, CryptoGroup> = {
  // Bitcoin
  "BTCE.DE": "BTC",   // BTCetc Physical Bitcoin (XETRA)
  "ABTC.SW": "BTC",   // 21Shares Bitcoin ETP (SIX)
  "BTCW.L":  "BTC",   // WisdomTree Physical Bitcoin (LSE)
  // Ethereum
  "ZETH.SW": "ETH",   // 21Shares Ethereum ETP (SIX)
  "ZETH.DE": "ETH",   // ETC Group Physical Ethereum (XETRA)
  // Diversified basket
  "HODL.SW": "Basket", // 21Shares Crypto Basket Index ETP
};

export const CRYPTO_SYMBOLS = Object.keys(CRYPTO_SYMBOL_MAP);

export function classifyCryptoSymbol(symbol: string): CryptoGroup | null {
  return CRYPTO_SYMBOL_MAP[symbol.toUpperCase()] ?? null;
}

export function isCryptoEtp(symbol: string): boolean {
  return classifyCryptoSymbol(symbol) !== null;
}
