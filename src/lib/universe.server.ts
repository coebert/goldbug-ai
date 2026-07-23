// Curated symbol universe by asset class. Uses Yahoo Finance ticker syntax
// (e.g. BTC-USD, GC=F, GBPUSD=X, VOD.L) which the price fetcher understands.
import type { Database } from "@/integrations/supabase/types";

export type AssetClass = Database["public"]["Enums"]["asset_class"];

export type UniverseSymbol = {
  symbol: string;
  name: string;
  asset_class: AssetClass;
};

export const UNIVERSE: UniverseSymbol[] = [
  // US stocks & ETFs
  { symbol: "SPY", name: "S&P 500 ETF", asset_class: "etf" },
  { symbol: "QQQ", name: "Nasdaq 100 ETF", asset_class: "etf" },
  { symbol: "VTI", name: "Total US Market ETF", asset_class: "etf" },
  { symbol: "AAPL", name: "Apple", asset_class: "stock" },
  { symbol: "MSFT", name: "Microsoft", asset_class: "stock" },
  { symbol: "GOOGL", name: "Alphabet", asset_class: "stock" },
  { symbol: "AMZN", name: "Amazon", asset_class: "stock" },
  { symbol: "NVDA", name: "NVIDIA", asset_class: "stock" },
  { symbol: "META", name: "Meta", asset_class: "stock" },
  { symbol: "TSLA", name: "Tesla", asset_class: "stock" },
  { symbol: "JPM", name: "JPMorgan", asset_class: "stock" },
  { symbol: "V", name: "Visa", asset_class: "stock" },
  { symbol: "JNJ", name: "Johnson & Johnson", asset_class: "stock" },
  // UK/EU
  { symbol: "VOD.L", name: "Vodafone (LON)", asset_class: "stock" },
  { symbol: "HSBA.L", name: "HSBC (LON)", asset_class: "stock" },
  { symbol: "BP.L", name: "BP (LON)", asset_class: "stock" },
  { symbol: "AZN.L", name: "AstraZeneca (LON)", asset_class: "stock" },
  { symbol: "ULVR.L", name: "Unilever (LON)", asset_class: "stock" },
  { symbol: "ISF.L", name: "iShares FTSE 100 ETF", asset_class: "etf" },
  // Crypto
  { symbol: "BTC-USD", name: "Bitcoin", asset_class: "crypto" },
  { symbol: "ETH-USD", name: "Ethereum", asset_class: "crypto" },
  { symbol: "SOL-USD", name: "Solana", asset_class: "crypto" },
  // Commodities
  { symbol: "GC=F", name: "Gold Futures", asset_class: "commodity" },
  { symbol: "SI=F", name: "Silver Futures", asset_class: "commodity" },
  { symbol: "CL=F", name: "Crude Oil Futures", asset_class: "commodity" },
  // FX
  { symbol: "GBPUSD=X", name: "GBP/USD", asset_class: "fx" },
  { symbol: "EURUSD=X", name: "EUR/USD", asset_class: "fx" },
  { symbol: "GBPEUR=X", name: "GBP/EUR", asset_class: "fx" },
];

export function filterUniverse(classes: AssetClass[]): UniverseSymbol[] {
  const allowed = new Set(classes);
  return UNIVERSE.filter((u) => allowed.has(u.asset_class));
}

export function findSymbol(sym: string): UniverseSymbol | undefined {
  return UNIVERSE.find((u) => u.symbol.toUpperCase() === sym.toUpperCase());
}

export type RiskProfile = {
  maxPositionPct: number; // max % of portfolio in any one asset
  cashFloorPct: number; // min % kept in cash
  maxNewPositionsPerDay: number;
};

export function riskProfile(level: Database["public"]["Enums"]["risk_level"]): RiskProfile {
  switch (level) {
    case "conservative":
      return { maxPositionPct: 0.1, cashFloorPct: 0.2, maxNewPositionsPerDay: 2 };
    case "aggressive":
      return { maxPositionPct: 0.25, cashFloorPct: 0.0, maxNewPositionsPerDay: 5 };
    case "balanced":
    default:
      return { maxPositionPct: 0.15, cashFloorPct: 0.1, maxNewPositionsPerDay: 3 };
  }
}
