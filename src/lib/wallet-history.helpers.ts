// Runtime helpers extracted from wallet-history.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const InputSchema = z.object({
  portfolioId: z.string().uuid(),
  sinceDays: z.number().int().min(1).max(3650).optional(),
});

export type WalletHistoryRow = {
  snapshot_date: string;
  base_ccy: string;
  base_total: number;
  cash_by_ccy: Record<string, number>;
};

export type WalletHistoryResult = {
  rows: WalletHistoryRow[];
  currencies: string[]; // union of currencies seen across the window
  baseCcy: string | null;
};
