// The real AI decision policy, wired into the trading-style backtest.
//
// Same model, same style prompt block and same order semantics as the live
// engine's decision call — but driven off backtest bars instead of live
// features, and cached on disk by prompt hash so a re-run of the same tape
// costs nothing and stays reproducible.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { generateText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import {
  buildStylePolicyPrompt,
  sanitisePolicyOrders,
  type PolicyContext,
  type PolicyOrder,
  type StylePolicy,
} from "./style-policy";

export const STYLE_POLICY_MODEL = "google/gemini-2.5-flash";

const OrdersSchema = z.object({
  orders: z.array(
    z.object({
      symbol: z.string(),
      side: z.enum(["buy", "sell"]),
      weight: z.number(),
      reason: z.string(),
    }),
  ),
});

const SYSTEM = [
  "You are the discretionary decision layer of a systematic trading engine.",
  "You choose entries and discretionary exits only; hard risk exits (stop, trailing stop,",
  "take-profit, time stop, scale-outs) are applied mechanically after you and are not yours to place.",
  "Be selective: trade only where the stated style's setup criteria are met.",
  "Respond with orders that obey every hard rule in the prompt.",
  'Reply with JSON only, exactly this shape: {"orders":[{"symbol":"AAPL","side":"buy","weight":0.18,"reason":"..."}]}.',
  '"side" is "buy" or "sell"; "weight" is a decimal fraction (0.18 = 18%), never a percent string.',
  'Use {"orders":[]} when no discretionary action is warranted. No prose, no markdown fences.',
].join(" ");

/** Best-effort recovery when the model returns JSON that misses the wrapper. */
export function coerceOrdersPayload(text: string | undefined): Array<Record<string, unknown>> {
  if (!text) return [];
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.search(/[[{]/);
  if (start < 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start));
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj["orders"])) return obj["orders"] as Array<Record<string, unknown>>;
    // A single bare order object.
    if (obj["symbol"]) return [obj];
  }
  return [];
}

/** Normalise loose field names/values the model sometimes emits. */
export function normaliseOrderFields(o: Record<string, unknown>): {
  symbol?: unknown;
  side?: unknown;
  weight?: unknown;
  reason?: unknown;
} {
  const side = String(o["side"] ?? o["order_type"] ?? o["action"] ?? "").toLowerCase();
  const rawWeight = o["weight"] ?? o["percent"] ?? o["amount"] ?? o["size"];
  const weight =
    typeof rawWeight === "string" ? Number(rawWeight.replace("%", "")) / 100 : Number(rawWeight);
  return {
    symbol: o["symbol"] ?? o["ticker"],
    side: side.includes("sell") ? "sell" : side.includes("buy") ? "buy" : undefined,
    weight,
    reason: o["reason"] ?? o["rationale"] ?? "ai",
  };
}

const CACHE_DIR = process.env["STYLE_POLICY_CACHE_DIR"] ?? "/tmp/aegis-style-policy-cache";

function cacheGet(key: string): PolicyOrder[] | null {
  try {
    const f = join(CACHE_DIR, `${key}.json`);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, "utf8")) as PolicyOrder[];
  } catch {
    return null;
  }
}

function cachePut(key: string, orders: PolicyOrder[]): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify(orders));
  } catch {
    /* cache is best-effort */
  }
}

export type AiStylePolicyStats = {
  calls: number;
  cacheHits: number;
  failures: number;
  /** Replies that missed the schema but were repaired from raw text. */
  repaired: number;
  emptyDecisions: number;
  orders: number;
};

/**
 * Build a `StylePolicy` backed by the AI gateway.
 * `cadenceBars` controls how often the model is consulted; risk exits still
 * run on every bar, exactly as they do live between hourly AI ticks.
 */
export function createAiStylePolicy(options: {
  apiKey: string;
  cadenceBars?: number;
  model?: string;
  /** Tag mixed into the cache key so unrelated runs never collide. */
  tag?: string;
  stats?: AiStylePolicyStats;
}): StylePolicy {
  const model = options.model ?? STYLE_POLICY_MODEL;
  const gateway = createLovableAiGatewayProvider(options.apiKey);
  const stats = options.stats;

  return {
    name: `ai:${model}`,
    cadenceBars: options.cadenceBars ?? 5,
    decide: async (ctx: PolicyContext): Promise<PolicyOrder[]> => {
      const prompt = buildStylePolicyPrompt(ctx);
      const key = createHash("sha256")
        .update(`${options.tag ?? ""}|${model}|${SYSTEM}|${prompt}`)
        .digest("hex")
        .slice(0, 32);

      const cached = cacheGet(key);
      if (cached) {
        if (stats) {
          stats.cacheHits++;
          stats.orders += cached.length;
          if (cached.length === 0) stats.emptyDecisions++;
        }
        return cached;
      }

      let orders: PolicyOrder[] = [];
      let attempt = 0;
      // Only 429 / 5xx are retryable; everything else is terminal.
      for (;;) {
        try {
          const result = await generateText({
            model: gateway(model),
            system: SYSTEM,
            prompt,
            temperature: 0,
            output: Output.object({ schema: OrdersSchema }),
          });
          orders = sanitisePolicyOrders(
            (result.output?.orders ?? []).map((o) => normaliseOrderFields(o as Record<string, unknown>)),
            ctx,
          );
          if (stats) stats.calls++;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const retryable = /\b(429|rate.?limit|500|502|503|504|overloaded|fetch failed)\b/i.test(
            message,
          );
          if (retryable && attempt < 4) {
            attempt++;
            await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
            continue;
          }
          if (stats) stats.failures++;
          // The gateway does not enforce json_schema for this model, so a
          // schema miss is recoverable: repair the raw text before giving up.
          // A truly unusable reply becomes "no discretionary action"; the
          // mechanical exit engine still manages open risk either way.
          const text = NoObjectGeneratedError.isInstance(error)
            ? (error as { text?: string }).text
            : undefined;
          orders = sanitisePolicyOrders(
            coerceOrdersPayload(text).map(normaliseOrderFields),
            ctx,
          );
          if (orders.length > 0 && stats) stats.repaired++;
          break;
        }
      }


      if (stats) {
        stats.orders += orders.length;
        if (orders.length === 0) stats.emptyDecisions++;
      }
      cachePut(key, orders);
      return orders;
    },
  };
}
