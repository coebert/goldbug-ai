// Runtime helpers extracted from trade-outcomes.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Real-time trade outcome feed: every recent live_orders row for a portfolio
 * with matched fills, error reasons, and timestamps. Powers the "Trade
 * Outcomes" panel that streams via Realtime on `live_orders` + `live_fills`.
 */

export type TradeOutcomeFill = {
  id: string;
  quantity: number;
  price: number;
  fee: number;
  currency: string;
  filledAt: string;
};

export type TradeOutcomeRow = {
  id: string;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  orderType: string;
  limitPrice: number | null;
  status: string; // pending | working | filled | partially_filled | rejected | error | cancelled
  brokerOrderId: string | null;
  clientOrderId: string | null;
  rejectReason: string | null;
  instrumentCcy: string;
  fills: TradeOutcomeFill[];
  filledQty: number;
  avgFillPrice: number | null;
};

export const InputSchema = z.object({
  portfolioId: z.string().uuid(),
  sinceHours: z.number().int().min(1).max(720).default(24),
  limit: z.number().int().min(1).max(200).default(80),
});
