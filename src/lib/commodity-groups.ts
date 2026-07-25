// Shared classifier that buckets a commodity ETF/ETC symbol into a human
// category. Used by:
//   * `commodity-exposure-card` to break down current holdings & activity
//   * `trading-engine.server` to enforce per-commodity-group risk caps
//   * `risk-controls-card` to render the per-group limit inputs
//
// Keeping the map in one place ensures the UI limits, engine enforcement
// and reporting cards always agree on which symbols belong to which group.

export type CommodityGroup =
  | "Gold"
  | "Silver"
  | "Platinum"
  | "Oil"
  | "Gas"
  | "Copper"
  | "Agriculture"
  | "Basket";

export const COMMODITY_GROUPS: CommodityGroup[] = [
  "Gold",
  "Silver",
  "Platinum",
  "Oil",
  "Gas",
  "Copper",
  "Agriculture",
  "Basket",
];

export const COMMODITY_SYMBOL_MAP: Record<string, CommodityGroup> = {
  "SGLN.L": "Gold", "SGLD.L": "Gold", "PHAU.L": "Gold", GLD: "Gold", IAU: "Gold",
  "SSLN.L": "Silver", "PHAG.L": "Silver", SLV: "Silver",
  "SPLT.L": "Platinum",
  "CRUD.L": "Oil", "BRNT.L": "Oil", USO: "Oil",
  "NGAS.L": "Gas",
  "COPA.L": "Copper",
  "AGCP.L": "Agriculture",
  "AIGB.L": "Basket", DBC: "Basket",
};

export function classifyCommoditySymbol(symbol: string): CommodityGroup | null {
  return COMMODITY_SYMBOL_MAP[symbol.toUpperCase()] ?? null;
}
