import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { z } from "zod";

import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Generate a concise, plain-English explanation for a single AI-proposed
 * buy/sell order (one row in `decisions.raw.executed`).
 *
 * The trading engine already produces a terse, jargon-heavy `reason` per order
 * plus a signal_weights breakdown. This function turns that into 2-3 sentences
 * an end-user without a trading background can understand: what the AI did,
 * why (in everyday terms), and — if the order was blocked — why the guardrail
 * stopped it. The output is cached per (decision_id, order_key) on the client
 * via React Query so it isn't regenerated on every render.
 */

const NewsItem = z
  .object({
    headline: z.string(),
    source: z.string().nullable().optional(),
  })
  .partial({ source: true });

const SignalWeightsInput = z
  .object({
    sma_trend: z.number(),
    rsi: z.number(),
    price_change: z.number(),
    news_sentiment: z.number(),
    volatility: z.number(),
  })
  .partial();

const ExplainInput = z.object({
  decisionId: z.string().min(1),
  orderKey: z.string().min(1),
  symbol: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  reason: z.string(),
  rejected: z.string().nullable().optional(),
  quantity: z.number(),
  price: z.number(),
  value: z.number(),
  currency: z.string().default("GBP"),
  weights: SignalWeightsInput.nullable().optional(),
  relatedNews: z.array(NewsItem).max(5).optional(),
  guardrails: z
    .object({
      risk_level: z.string().optional(),
      max_position_pct: z.number().optional(),
      cash_floor_pct: z.number().optional(),
    })
    .partial()
    .nullable()
    .optional(),
});

export type ExplainOrderInput = z.infer<typeof ExplainInput>;
export type ExplainOrderOutput = {
  decisionId: string;
  orderKey: string;
  explanation: string;
  model: string;
};

function topWeights(w: z.infer<typeof SignalWeightsInput> | null | undefined) {
  if (!w) return [] as Array<[string, number]>;
  const entries = Object.entries(w)
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => [k, Number(v)] as [string, number])
    .sort((a, b) => b[1] - a[1]);
  return entries.slice(0, 3);
}

const SIGNAL_HUMAN: Record<string, string> = {
  sma_trend: "the medium-term trend (moving averages)",
  rsi: "momentum (RSI — overbought/oversold)",
  price_change: "recent price action",
  news_sentiment: "the tone of recent news",
  volatility: "how choppy the price has been",
};

export const explainDecisionOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ExplainInput.parse(input))
  .handler(async ({ data }): Promise<ExplainOrderOutput> => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("Missing LOVABLE_API_KEY");

    const weights = topWeights(data.weights ?? null)
      .map(([k, v]) => `- ${SIGNAL_HUMAN[k] ?? k}: ${(v * 100).toFixed(0)}%`)
      .join("\n");

    const news =
      data.relatedNews && data.relatedNews.length
        ? data.relatedNews
            .slice(0, 3)
            .map(
              (n) =>
                `- ${n.headline}${n.source ? ` (${n.source})` : ""}`,
            )
            .join("\n")
        : "";

    const guardrailNote = data.rejected
      ? `The order was BLOCKED by a guardrail. Guardrail reason: "${data.rejected}". Explain why the safety rule stopped this trade in plain terms.`
      : "The order was executed within the portfolio's safety rules.";

    const prompt = `You are explaining an automated trading decision to a non-technical investor.

Write 2-3 short sentences, no jargon, no bullet points, no markdown. Do not restate raw numbers already shown in the UI (quantity, price, weights). Focus on WHY the AI made this call in everyday language, and — if it was blocked — why the safety rule stopped it. Never give financial advice, never predict outcomes.

Order:
- Action: ${data.side.toUpperCase()} ${data.symbol}
- Size: ${data.quantity} units at ${data.currency} ${data.price} (${data.currency} ${data.value})
${guardrailNote}

AI's internal reason: "${data.reason}"

${weights ? `Top drivers the AI weighted most heavily:\n${weights}` : ""}
${news ? `\nHeadlines the AI considered:\n${news}` : ""}`;

    const gateway = createLovableAiGatewayProvider(key);
    const model = "google/gemini-3.6-flash";
    const { text } = await generateText({
      model: gateway(model),
      prompt,
    });

    const cleaned = (text ?? "")
      .replace(/^[\s>*_-]+|[\s]+$/g, "")
      .slice(0, 600);

    return {
      decisionId: data.decisionId,
      orderKey: data.orderKey,
      explanation:
        cleaned ||
        "Could not generate a plain-English summary for this order.",
      model,
    };
  });
