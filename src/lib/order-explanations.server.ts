import { z } from "zod";
import { generateText } from "ai";

import { createLovableAiGatewayProvider } from "./ai-gateway.server";

/**
 * Server-only helpers for building the plain-English explanation of a
 * single AI-proposed order. Kept in a sibling `.server.ts` module so
 * `order-explanations.functions.ts` stays a thin wrapper (see
 * `scripts/check-serverfn-shape.ts`).
 */

export const NewsItemSchema = z
  .object({
    headline: z.string(),
    source: z.string().nullable().optional(),
  })
  .partial({ source: true });

export const SignalWeightsInputSchema = z
  .object({
    sma_trend: z.number(),
    rsi: z.number(),
    price_change: z.number(),
    news_sentiment: z.number(),
    volatility: z.number(),
  })
  .partial();

export const ExplainInputSchema = z.object({
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
  weights: SignalWeightsInputSchema.nullable().optional(),
  relatedNews: z.array(NewsItemSchema).max(5).optional(),
  guardrails: z
    .object({
      risk_level: z.string().optional(),
      max_position_pct: z.number().optional(),
      cash_floor_pct: z.number().optional(),
    })
    .partial()
    .nullable()
    .optional(),
  tradingStyle: z.enum(["position", "swing"]).nullable().optional(),
});

export type ExplainOrderInput = z.infer<typeof ExplainInputSchema>;
export type ExplainOrderOutput = {
  decisionId: string;
  orderKey: string;
  explanation: string;
  model: string;
};

const SIGNAL_HUMAN: Record<string, string> = {
  sma_trend: "the medium-term trend (moving averages)",
  rsi: "momentum (RSI — overbought/oversold)",
  price_change: "recent price action",
  news_sentiment: "the tone of recent news",
  volatility: "how choppy the price has been",
};

function topWeights(
  w: z.infer<typeof SignalWeightsInputSchema> | null | undefined,
): Array<[string, number]> {
  if (!w) return [];
  return Object.entries(w)
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => [k, Number(v)] as [string, number])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
}

export function buildExplainPrompt(data: ExplainOrderInput): string {
  const weights = topWeights(data.weights ?? null)
    .map(([k, v]) => `- ${SIGNAL_HUMAN[k] ?? k}: ${(v * 100).toFixed(0)}%`)
    .join("\n");

  const news =
    data.relatedNews && data.relatedNews.length
      ? data.relatedNews
          .slice(0, 3)
          .map((n) => `- ${n.headline}${n.source ? ` (${n.source})` : ""}`)
          .join("\n")
      : "";

  const guardrailNote = data.rejected
    ? `The order was BLOCKED by a guardrail. Guardrail reason: "${data.rejected}". Explain why the safety rule stopped this trade in plain terms.`
    : "The order was executed within the portfolio's safety rules.";

  return `You are explaining an automated trading decision to a non-technical investor.

Write 2-3 short sentences, no jargon, no bullet points, no markdown. Do not restate raw numbers already shown in the UI (quantity, price, weights). Focus on WHY the AI made this call in everyday language, and — if it was blocked — why the safety rule stopped it. Never give financial advice, never predict outcomes.

Order:
- Action: ${data.side.toUpperCase()} ${data.symbol}
- Size: ${data.quantity} units at ${data.currency} ${data.price} (${data.currency} ${data.value})
${guardrailNote}

AI's internal reason: "${data.reason}"

${weights ? `Top drivers the AI weighted most heavily:\n${weights}` : ""}
${news ? `\nHeadlines the AI considered:\n${news}` : ""}`;
}

export type ExplanationCacheClient = {
  from: (table: string) => any;
};

/** Stable short hash of the prompt, so a changed prompt invalidates the cache. */
async function hashPrompt(prompt: string): Promise<string> {
  const bytes = new TextEncoder().encode(prompt);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Explanations are deterministic per (decision, order, prompt): the underlying
 * order never changes once written. Without a cache every click of "explain"
 * — and every page reload — bought a fresh Gemini call. We persist the first
 * result and serve it back for free afterwards.
 */
export async function runExplainOrder(
  data: ExplainOrderInput,
  db?: ExplanationCacheClient,
): Promise<ExplainOrderOutput> {
  const prompt = buildExplainPrompt(data);
  const promptHash = await hashPrompt(prompt);

  if (db) {
    try {
      const { data: hit } = await db
        .from("order_explanations")
        .select("explanation, model")
        .eq("decision_id", data.decisionId)
        .eq("order_key", data.orderKey)
        .eq("prompt_hash", promptHash)
        .maybeSingle();
      if (hit?.explanation) {
        return {
          decisionId: data.decisionId,
          orderKey: data.orderKey,
          explanation: hit.explanation as string,
          model: (hit.model as string | null) ?? "cache",
        };
      }
    } catch (err) {
      console.warn("order explanation cache read failed", err);
    }
  }

  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("Missing LOVABLE_API_KEY");

  const gateway = createLovableAiGatewayProvider(key);
  const model = "google/gemini-3.6-flash";

  const { text } = await generateText({
    model: gateway(model),
    prompt,
  });

  const cleaned = (text ?? "").replace(/^[\s>*_-]+|[\s]+$/g, "").slice(0, 600);
  const explanation =
    cleaned || "Could not generate a plain-English summary for this order.";

  if (db && cleaned) {
    try {
      await db.from("order_explanations").insert({
        decision_id: data.decisionId,
        order_key: data.orderKey,
        prompt_hash: promptHash,
        explanation,
        model,
      });
    } catch (err) {
      console.warn("order explanation cache write failed", err);
    }
  }

  return {
    decisionId: data.decisionId,
    orderKey: data.orderKey,
    explanation,
    model,
  };
}
