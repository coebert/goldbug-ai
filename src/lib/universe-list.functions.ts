// Client-callable read of the curated symbol universe. Wraps the server-only
// `UNIVERSE` array so the UI can render an "Investable Universe" panel
// grouped by asset class (stocks, ETFs, crypto ETPs, commodities, FX)
// without importing the .server module into the client bundle.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { classifyInvestability } from "./universe-list.helpers";
import type { InvestabilityStatus, InvestableUniverseEntry, ClassifyResult } from "./universe-list.helpers";
export { classifyInvestability };
export type { InvestabilityStatus, InvestableUniverseEntry };

export const listInvestableUniverse = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(
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
