// Runtime helpers extracted from order-reconciliation-view.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type ReconOrderRow = {
  id: string;
  portfolio_id: string;
  portfolio_name: string | null;
  symbol: string;
  side: string;
  quantity: number;
  order_type: string;
  status: string;
  broker_order_id: string | null;
  reject_reason: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
  first_fill_at: string | null;
  latency_ms: number | null;
  filled_quantity: number;
  avg_fill_price: number | null;
};

export const InputSchema = z
  .object({
    hours: z.number().int().min(1).max(24 * 30).default(72),
    portfolioId: z.string().uuid().optional(),
  })
  .default({ hours: 72 });
