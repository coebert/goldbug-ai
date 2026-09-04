import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export function createLovableAiGatewayProvider(
  lovableApiKey: string,
  opts: { structuredOutputs?: boolean } = {},
) {
  return createOpenAICompatible({
    name: "lovable",
    baseURL: "https://ai.gateway.lovable.dev/v1",
    // Native json_schema response format: without it the model free-forms its
    // JSON and routinely omits required fields, which surfaced as constant
    // "structured output parse error" fallbacks.
    supportsStructuredOutputs: opts.structuredOutputs ?? false,
    headers: {
      "Lovable-API-Key": lovableApiKey,
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
  });
}
