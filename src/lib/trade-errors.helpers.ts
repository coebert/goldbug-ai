// Runtime helpers extracted from trade-errors.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Trade error dashboard data source.
 *
 * Reads the user's own live_orders + live_broker_log rows via the RLS-scoped
 * client and stitches each failed order together with the pre-placement
 * signals that shaped or blocked it in the same tick:
 *
 *   - PRE_PLACE_RECONCILE        top-of-tick broker cash refresh
 *   - FX_CAPTURE                 portfolio→broker currency conversion
 *   - PRE_PLACE_AFFORDABILITY    budget trim decisions
 *   - PRE_PLACE_FX_BLOCK         FX unavailable → cross-ccy buys blocked
 *   - PRECHECK_REJECT            broker-side precheck rejection
 *
 * Each error row exposes: order metadata, root-cause error code + message,
 * the FX source/rate/stale flag that was captured in the same window, and
 * the specific affordability decision (allowed / skipped / blocked) so the
 * user can see exactly why the trade failed without reading log JSON.
 */

export type TradeErrorRow = {
  id: string;
  createdAt: string;
  portfolioId: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  status: string; // "error" | "rejected"
  brokerOrderId: string | null;
  rejectReason: string | null;
  rootCauseCode: string | null;
  rootCauseMessage: string | null;
  fx: {
    from: string | null;
    to: string | null;
    rate: number | null;
    source: string | null;
    stale: boolean | null;
  } | null;
  affordability:
    | { kind: "allowed"; notionalBrokerCcy: number | null }
    | { kind: "skipped"; reason: string; notionalBrokerCcy: number | null }
    | { kind: "fx_blocked"; reason: string }
    | { kind: "no_data" };
};

export const InputSchema = z.object({
  portfolioId: z.string().uuid(),
  sinceHours: z.number().int().min(1).max(720).default(72),
  limit: z.number().int().min(1).max(200).default(100),
});

export type LogRow = {
  id: string;
  created_at: string;
  method: string;
  path: string;
  status: number | null;
  request: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
  error: string | null;
};

export function nearestBefore<T extends { created_at: string }>(
  rows: T[],
  at: string,
  windowMs = 10 * 60 * 1000,
): T | null {
  const atMs = Date.parse(at);
  let best: T | null = null;
  let bestDelta = Infinity;
  for (const r of rows) {
    const rMs = Date.parse(r.created_at);
    const delta = atMs - rMs;
    if (delta >= 0 && delta <= windowMs && delta < bestDelta) {
      best = r;
      bestDelta = delta;
    }
  }
  return best;
}
