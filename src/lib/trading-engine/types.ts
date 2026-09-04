// Shared types + AI decision schemas for the trading engine.
// Extracted from trading-engine.server.ts (behaviour unchanged).
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { FxConversionOrderSchema } from "../ai-fx-conversions.server";
import { FxIntentSchema } from "../fx-intents";

export type Portfolio = Database["public"]["Tables"]["portfolios"]["Row"];
export type Holding = Database["public"]["Tables"]["holdings"]["Row"];

export const SignalWeightsSchema = z.object({
  sma_trend: z.number().min(0).max(100),
  rsi: z.number().min(0).max(100),
  price_change: z.number().min(0).max(100),
  news_sentiment: z.number().min(0).max(100),
  volatility: z.number().min(0).max(100),
});

export const OrderSchema = z.object({
  symbol: z.string(),
  side: z.enum(["buy", "sell"]),
  percent: z.number(),
  // 0..1 model confidence in this specific call (used for Kelly-capped sizing)
  conviction: z.number().min(0).max(1).optional(),
  reason: z.string(),
  signal_weights: SignalWeightsSchema,
});

export const DecisionSchema = z.object({
  briefing: z.string(),
  rationale: z.string(),
  orders: z.array(OrderSchema),
  /**
   * True when this decision came from the non-AI heuristic fallback (the AI
   * gateway was unreachable). Sizing downstream is deliberately tightened.
   */
  ai_unavailable: z.boolean().optional(),
  fx_conversions: z.array(FxConversionOrderSchema).optional(),
  fx_intents: z.array(FxIntentSchema).optional(),
});

export type DecisionOutput = z.infer<typeof DecisionSchema>;

export type ExecutedTrade = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  value: number;
  reason: string;
  rejected?: string;
  instrument_ccy?: string;
  // Sizing telemetry — populated for commodity trades so the decision/executed
  // rows expose the same slippage/liquidity numbers the sizer used.
  liquidity?: import("../commodity-liquidity-metrics").CommodityTradeLiquidity;
  // Phase 6 — execution alpha telemetry.
  slice_plan?: { childCount: number; childNotional: number; advParticipationPct: number | null; reason: string };
  tod?: { multiplier: number; allow: boolean; reason: string };
  // SMA trend telemetry — the snapshot the crossover rules saw for this
  // symbol at decision time, so the UI can explain the trend influence.
  sma_cross?: import("../alpha/sma-cross-rules").SmaCrossState | null;
  /**
   * Conviction in [0,1] from the unified systematic score, and the resolved
   * sector. Carried on the order so downstream cost/concentration gates rank
   * and cap without re-deriving signals.
   */
  conviction?: number;
  sector?: string;
};

