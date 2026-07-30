// Server side of portfolio-aware news relevance.
//
// Builds the user's trading context (held symbols, tradable universe,
// currencies, dominant risk level), asks the LLM to judge each fresh headline
// against it, blends that with the deterministic heuristic, and persists the
// result on `news_cache` so the reel can prioritise before display.

import { generateText } from "ai";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import {
  blendRelevance,
  clampRelevance,
  heuristicRelevance,
  type RelevanceContext,
  type RelevanceScore,
  type RiskLevel,
} from "./news-relevance";

const RISK_ORDER: RiskLevel[] = ["conservative", "balanced", "aggressive"];

/** Read the user's live book so scoring reflects what they actually own. */
export async function loadRelevanceContext(): Promise<RelevanceContext> {
  const [{ data: portfolios }, { data: holdings }] = await Promise.all([
    supabaseAdmin.from("portfolios").select("id, universe, risk_level, currency, status"),
    supabaseAdmin.from("holdings").select("symbol, asset_class, instrument_ccy, quantity"),
  ]);

  const assetClasses = new Set<string>();
  const currencies = new Set<string>();
  const riskCounts = new Map<RiskLevel, number>();

  for (const p of portfolios ?? []) {
    if ((p.status as string | null) === "archived") continue;
    const uni = Array.isArray(p.universe) ? (p.universe as unknown[]) : [];
    for (const c of uni) if (typeof c === "string") assetClasses.add(c.toLowerCase());
    if (typeof p.currency === "string") currencies.add(p.currency.toUpperCase());
    const rl = (p.risk_level ?? "balanced") as RiskLevel;
    if (RISK_ORDER.includes(rl)) riskCounts.set(rl, (riskCounts.get(rl) ?? 0) + 1);
  }

  const symbols = new Set<string>();
  for (const h of holdings ?? []) {
    if (Number(h.quantity) <= 0) continue;
    if (typeof h.symbol === "string") symbols.add(h.symbol.toUpperCase());
    if (typeof h.asset_class === "string") assetClasses.add(h.asset_class.toLowerCase());
    if (typeof h.instrument_ccy === "string") currencies.add(h.instrument_ccy.toUpperCase());
  }

  // Dominant risk level: most common across active portfolios, ties resolved
  // towards the more aggressive book (it reacts to more kinds of news).
  let riskLevel: RiskLevel = "balanced";
  let bestCount = -1;
  for (const rl of RISK_ORDER) {
    const n = riskCounts.get(rl) ?? 0;
    if (n >= bestCount && n > 0) {
      bestCount = n;
      riskLevel = rl;
    }
  }

  if (assetClasses.size === 0) assetClasses.add("equity");
  if (currencies.size === 0) currencies.add("GBP");

  return {
    symbols: Array.from(symbols).slice(0, 120),
    names: [],
    assetClasses: Array.from(assetClasses),
    currencies: Array.from(currencies).slice(0, 8),
    riskLevel,
  };
}

const LlmSchema = z.object({
  scores: z.array(
    z.object({
      i: z.number(),
      score: z.number(),
      reason: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
  ),
});

function parseLlmPayload(raw: string): Map<number, RelevanceScore> {
  const out = new Map<number, RelevanceScore>();
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return out;
  }
  const normalized = Array.isArray(parsed) ? { scores: parsed } : parsed;
  const result = LlmSchema.safeParse(normalized);
  if (!result.success) return out;
  for (const s of result.data.scores) {
    out.set(s.i, {
      score: clampRelevance(s.score),
      reason: (s.reason ?? "").slice(0, 220),
      tags: (s.tags ?? []).map((t) => String(t).slice(0, 24)).slice(0, 6),
    });
  }
  return out;
}

const BATCH = 25;

async function scoreBatchWithLlm(
  items: Array<{ i: number; headline: string; source: string | null }>,
  ctx: RelevanceContext,
): Promise<Map<number, RelevanceScore>> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key || items.length === 0) return new Map();

  const gateway = createLovableAiGatewayProvider(key);
  const model = gateway("google/gemini-3.1-flash-lite");

  const prompt = `You rank financial news by how likely it is to move a specific portfolio in the next 1-10 trading days.

Portfolio context:
- Risk level: ${ctx.riskLevel}
- Holdings: ${ctx.symbols.length > 0 ? ctx.symbols.slice(0, 60).join(", ") : "(none yet — cash)"}
- Tradable asset classes: ${ctx.assetClasses.join(", ")}
- Currency exposure: ${ctx.currencies.join(", ")}

Score each headline 0-100:
- 80-100: names a holding, or a shock that directly reprices these asset classes.
- 60-79: strong macro/sector driver for this book (rates, inflation, sector-wide moves).
- 40-59: relevant backdrop, indirect.
- 20-39: general market colour.
- 0-19: irrelevant to this portfolio (sport, entertainment, local human interest).
Weight for the risk level: a conservative book cares most about rates, credit and drawdown risk; an aggressive book cares more about earnings momentum, crypto and single-name catalysts.

Reply ONLY as JSON: {"scores":[{"i":0,"score":72,"reason":"one short sentence","tags":["rates"]}]}

Headlines:
${items.map((it) => `${it.i}. [${it.source ?? "unknown"}] ${it.headline}`).join("\n")}`;

  try {
    const { text } = await generateText({ model, prompt });
    return parseLlmPayload(text);
  } catch (err) {
    console.warn("news-relevance: LLM scoring failed", err instanceof Error ? err.message : String(err));
    return new Map();
  }
}

export type RelevanceScoredRow = {
  id: string;
  headline: string;
  relevance_score: number;
  relevance_reason: string;
  relevance_tags: string[];
};

/**
 * Score every unscored `news_cache` row for the given date and persist the
 * result. Idempotent: rows that already carry a score are skipped unless
 * `rescore` is set (used when the book changes materially).
 */
export async function ensureRelevanceScored(
  dateISO: string,
  opts?: { rescore?: boolean; max?: number; ctx?: RelevanceContext },
): Promise<{ scored: number; skipped: number; date: string }> {
  const ctx = opts?.ctx ?? (await loadRelevanceContext());
  const max = Math.max(1, Math.min(200, opts?.max ?? 120));

  let query = supabaseAdmin
    .from("news_cache")
    .select("id, headline, summary, source, source_weight, relevance_score")
    .eq("news_date", dateISO)
    .order("fetched_at", { ascending: false })
    .limit(max);
  if (!opts?.rescore) query = query.is("relevance_score", null);

  const { data: rows, error } = await query;
  if (error) {
    console.warn("news-relevance: read failed", error.message);
    return { scored: 0, skipped: 0, date: dateISO };
  }
  const pending = rows ?? [];
  if (pending.length === 0) return { scored: 0, skipped: 0, date: dateISO };

  // Heuristic first — it is the guaranteed floor even if the LLM call fails.
  const heuristics = pending.map((r) =>
    heuristicRelevance(
      {
        headline: (r.headline as string) ?? "",
        summary: (r.summary as string | null) ?? null,
        source: (r.source as string | null) ?? null,
        source_weight: r.source_weight == null ? null : Number(r.source_weight),
      },
      ctx,
    ),
  );

  const llm = new Map<number, RelevanceScore>();
  for (let start = 0; start < pending.length; start += BATCH) {
    const slice = pending.slice(start, start + BATCH).map((r, k) => ({
      i: start + k,
      headline: (r.headline as string) ?? "",
      source: (r.source as string | null) ?? null,
    }));
    const batch = await scoreBatchWithLlm(slice, ctx);
    for (const [i, v] of batch) llm.set(i, v);
  }

  let scored = 0;
  await Promise.all(
    pending.map(async (r, i) => {
      const merged = blendRelevance(heuristics[i], llm.get(i) ?? null);
      const { error: upErr } = await supabaseAdmin
        .from("news_cache")
        .update({
          relevance_score: merged.score,
          relevance_reason: merged.reason,
          relevance_tags: merged.tags,
        })
        .eq("id", r.id as string);
      if (upErr) console.warn("news-relevance: update failed", upErr.message);
      else scored += 1;
    }),
  );

  return { scored, skipped: pending.length - scored, date: dateISO };
}
