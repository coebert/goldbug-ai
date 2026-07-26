// Client-callable read of the curated symbol universe. Wraps the server-only
// `UNIVERSE` array so the UI can render an "Investable Universe" panel
// grouped by asset class (stocks, ETFs, crypto ETPs, commodities, FX)
// without importing the .server module into the client bundle.

import { createServerFn } from "@tanstack/react-start";

export type InvestableUniverseEntry = {
  symbol: string;
  name: string;
  asset_class: "stock" | "etf" | "crypto" | "commodity" | "fx";
  // True when the instrument is routable via Saxo retail cash accounts.
  // Yahoo spot pairs (`-USD`, `=X`) and futures pseudo-symbols (`=F`) are
  // kept in the universe for price/backtest coverage but are NOT tradable.
  saxo_tradable: boolean;
};

export const listInvestableUniverse = createServerFn({ method: "GET" }).handler(
  async (): Promise<InvestableUniverseEntry[]> => {
    const { UNIVERSE } = await import("./universe.server");
    return UNIVERSE.map((u) => {
      const s = u.symbol.toUpperCase();
      const untradeable = s.endsWith("=X") || s.endsWith("=F") || s.endsWith("-USD");
      return {
        symbol: u.symbol,
        name: u.name,
        asset_class: u.asset_class as InvestableUniverseEntry["asset_class"],
        saxo_tradable: !untradeable,
      };
    });
  },
);
