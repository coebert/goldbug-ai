// Runtime helpers extracted from commodity-liquidity.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// Simulate slippage and liquidity impact for commodity trades. Reads recent
// price_cache rows to estimate ADV$, spread proxy (high-low as % of close),
// and realized volatility (used as ATR% surrogate for the execution model).
// Returns per-symbol stats plus a rejection-risk score that combines:
//   - liquidity trim (requested spend vs 1% ADV cap)
//   - spread width (bps)
//   - data staleness / missing rows
//   - low nominal ADV$ (thin markets)
//
// Server-only: reads Supabase price_cache with the caller's session.

export const InputSchema = z.object({
  // Target notional per trade in USD-equivalent (we use the raw price ccy;
  // callers who care about FX can convert on the client).
  targetSpend: z.number().positive().max(10_000_000).default(10_000),
  // Optional subset of symbols; defaults to the full commodity universe.
  symbols: z.array(z.string()).optional(),
  // Lookback window in trading days (~1 calendar month by default).
  lookbackDays: z.number().int().min(5).max(120).default(20),
});

export type CommodityLiquiditySymbol = {
  symbol: string;
  name: string;
  ok: boolean;
  reason?: string;
  lastClose: number | null;
  lastDate: string | null;
  adv20d: number | null;         // dollar volume, 20d average
  spreadBpsAvg: number | null;   // avg (high-low)/close in bps
  atrPct: number | null;         // realized vol proxy
  targetSpend: number;
  liquidityCapSpend: number | null;
  trimmed: boolean;
  trimFraction: number;          // 0 = no trim, 1 = fully trimmed
  estSlippageBps: number | null; // half-spread + slippage
  estCostPct: number | null;     // cost / requestedSpend (round-trip)
  stale: boolean;                // last close older than 7 calendar days
  rejectionScore: number;        // 0-100
  rejectionBucket: "low" | "medium" | "high";
  notes: string[];
};

export type CommodityLiquidityResult = {
  targetSpend: number;
  lookbackDays: number;
  runAt: string;
  rows: CommodityLiquiditySymbol[];
};

export function bucket(score: number): "low" | "medium" | "high" {
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  return "low";
}
