// Server-only: ask Lovable AI to interpret the deterministic chart brief.

import { generateText } from "ai";

import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import {
  buildTechnicalReadPrompt,
  fallbackRead,
  parseTechnicalReadReply,
  type TechnicalBrief,
  type TechnicalRead,
} from "./technical-read";

const MODEL = "google/gemini-3.6-flash";

export async function interpretChart(brief: TechnicalBrief): Promise<TechnicalRead> {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) return { ...fallbackRead(brief), model: null, brief };

  try {
    const gateway = createLovableAiGatewayProvider(key);
    const { text } = await generateText({
      model: gateway(MODEL),
      prompt: buildTechnicalReadPrompt(brief),
    });
    const parsed = parseTechnicalReadReply(text ?? "");
    if (!parsed) return { ...fallbackRead(brief), model: null, brief };
    return { ...parsed, model: MODEL, brief };
  } catch (err) {
    console.warn("interpretChart: falling back to deterministic read", err);
    return { ...fallbackRead(brief), model: null, brief };
  }
}
