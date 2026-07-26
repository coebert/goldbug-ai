// Client-callable read of the curated symbol universe. Wraps the server-only
// `UNIVERSE` array so the UI can render an "Investable Universe" panel
// grouped by asset class (stocks, ETFs, crypto ETPs, commodities, FX)
// without importing the .server module into the client bundle.

import { createServerFn } from "@tanstack/react-start";

export type InvestabilityStatus = "candidate" | "blocked";

export type InvestableUniverseEntry = {
  symbol: string;
  name: string;
  asset_class: "stock" | "etf" | "crypto" | "commodity" | "fx";
  /**
   * True when the instrument is routable via Saxo retail cash accounts.
   * Yahoo spot pairs (`-USD`, `=X`) and futures pseudo-symbols (`=F`) are
   * kept in the universe for price/backtest coverage but are NOT tradable.
   */
  saxo_tradable: boolean;
  /** High-level tradability marker for the universe panel. */
  status: InvestabilityStatus;
  /** Machine-readable reason code when status = "blocked". */
  block_reason_code:
    | "spot_fx_reference"
    | "futures_pseudo_symbol"
    | "crypto_spot_pair"
    | null;
  /** Human-readable explanation for the tooltip/legend. */
  status_explanation: string;
};

type ClassifyResult = Pick<
  InvestableUniverseEntry,
  "saxo_tradable" | "status" | "block_reason_code" | "status_explanation"
>;

export function classifyInvestability(symbol: string, name: string): ClassifyResult {
  const s = symbol.toUpperCase();
  if (s.endsWith("=X")) {
    return {
      saxo_tradable: false,
      status: "blocked",
      block_reason_code: "spot_fx_reference",
      status_explanation:
        `${name} — Yahoo spot FX reference used for pricing/backtests. Not routed as a discrete order; FX exposure is managed via cash wallet trims.`,
    };
  }
  if (s.endsWith("=F")) {
    return {
      saxo_tradable: false,
      status: "blocked",
      block_reason_code: "futures_pseudo_symbol",
      status_explanation:
        `${name} — futures pseudo-symbol used for reference pricing only. Cash accounts cannot trade futures; use the corresponding physically-backed ETP instead.`,
    };
  }
  if (s.endsWith("-USD")) {
    return {
      saxo_tradable: false,
      status: "blocked",
      block_reason_code: "crypto_spot_pair",
      status_explanation:
        `${name} — crypto spot pair. Saxo cash accounts do not trade spot crypto; use an approved physically-backed ETP (BTCE.DE, ABTC.SW, VBTC.L, ZETH.SW, ETHE.DE, HODL.SW).`,
    };
  }
  return {
    saxo_tradable: true,
    status: "candidate",
    block_reason_code: null,
    status_explanation: `${name} — Saxo-tradable candidate. Subject to per-run risk, liquidity and market-hours gates.`,
  };
}

export const listInvestableUniverse = createServerFn({ method: "GET" }).handler(
  async (): Promise<InvestableUniverseEntry[]> => {
    const { UNIVERSE } = await import("./universe.server");
    return UNIVERSE.map((u) => {
      const c = classifyInvestability(u.symbol, u.name);
      return {
        symbol: u.symbol,
        name: u.name,
        asset_class: u.asset_class as InvestableUniverseEntry["asset_class"],
        ...c,
      };
    });
  },
);
