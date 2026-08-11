// Server-only: turn deterministic chart events into plain-English annotations
// using Lovable AI. Any failure degrades to the deterministic wording.

import { generateText } from "ai";

import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import {
  buildAnnotationPrompt,
  mergeAnnotations,
  parseAnnotationReply,
  type AnnotationNewsItem,
  type ChartAnnotation,
  type ChartEvent,
} from "./chart-annotations";

const MODEL = "google/gemini-3.6-flash";

export async function explainChartEvents(args: {
  label: string;
  symbol: string;
  days: number;
  events: ChartEvent[];
  news: AnnotationNewsItem[];
}): Promise<ChartAnnotation[]> {
  const { label, symbol, days, events, news } = args;
  if (!events.length) return [];

  const key = process.env["LOVABLE_API_KEY"];
  if (!key) return mergeAnnotations(events, {}, null);

  try {
    const gateway = createLovableAiGatewayProvider(key);
    const { text } = await generateText({
      model: gateway(MODEL),
      prompt: buildAnnotationPrompt(label, symbol, days, events, news),
    });
    const notes = parseAnnotationReply(text ?? "");
    return mergeAnnotations(events, notes, MODEL);
  } catch (err) {
    console.warn("explainChartEvents: falling back to deterministic notes", err);
    return mergeAnnotations(events, {}, null);
  }
}
