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
};
