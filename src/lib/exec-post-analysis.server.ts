// Server-only: runs the executive-post ↔ market-pattern study, asks the AI to
// interpret it, and persists both the raw events and the resulting lessons.
//
// The study half is deterministic (see `exec-post-study.ts`); the AI half only
// writes the narrative, the lesson list, and *bounded* adjustments to the
// derived coefficients — every number it returns is re-clamped by
// `mergeCoefficientAdjustments` before it can reach the trading engine.

import { generateText } from "ai";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { detectExecutivePosts, TRACKED_EXECUTIVES, type ExecPostRow } from "./exec-posts";
import {
  buildExecPostEvents,
  summariseStudy,
  type ExecPostEvent,
  type ExecPostStudySummary,
  type PriceBar,
} from "./exec-post-study";
import {
  deriveCoefficients,
  mergeCoefficientAdjustments,
  type ExecPostCoefficient,
  type ExecPostCoefficientAdjustment,
  type ExecPostLessonSet,
} from "./exec-post-learning";

const MODEL = "google/gemini-2.5-flash";

type Sb = {
  from: (table: string) => any;
};

export type ExecPostStudyResult = {
  summary: ExecPostStudySummary;
  events: ExecPostEvent[];
  lessons: ExecPostLessonSet;
  persisted_events: number;
  ai_error: string | null;
};

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Loads candidate news rows and turns them into detected executive posts. */
export async function loadDetectedPosts(supabase: Sb, sinceDate: string) {
  const { data } = await supabase
    .from("news_cache")
    .select("news_date, source, headline, url, summary, sentiment")
    .gte("news_date", sinceDate)
    .order("news_date", { ascending: false })
    .limit(4000);

  const rows: ExecPostRow[] = (data ?? []).map((r: Record<string, unknown>) => ({
    headline: (r["headline"] as string) ?? "",
    source: (r["source"] as string | null) ?? null,
    url: (r["url"] as string | null) ?? null,
    summary: (r["summary"] as string | null) ?? null,
    date: (r["news_date"] as string) ?? null,
    sentiment: r["sentiment"] == null ? null : Number(r["sentiment"]),
  }));

  return detectExecutivePosts(rows);
}

/** Ascending close series per symbol, from the shared price cache. */
export async function loadPriceSeries(
  supabase: Sb,
  symbols: string[],
  sinceDate: string,
): Promise<Map<string, PriceBar[]>> {
  const out = new Map<string, PriceBar[]>();
  if (symbols.length === 0) return out;

  const { data } = await supabase
    .from("price_cache")
    .select("symbol, price_date, close")
    .in("symbol", symbols)
    .gte("price_date", sinceDate)
    .order("price_date", { ascending: true })
    .limit(20000);

  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const symbol = String(row["symbol"] ?? "").toUpperCase();
    const close = Number(row["close"]);
    if (!symbol || !Number.isFinite(close)) continue;
    const list = out.get(symbol) ?? [];
    list.push({ date: String(row["price_date"]).slice(0, 10), close });
    out.set(symbol, list);
  }
  return out;
}

function buildPrompt(summary: ExecPostStudySummary, events: ExecPostEvent[]): string {
  const sample = events.slice(0, 40).map((e) => ({
    d: e.post_date,
    who: e.executive_name,
    sym: e.symbol,
    sent: e.sentiment,
    r1: e.ret_1d,
    r5: e.ret_5d,
    headline: e.headline.slice(0, 120),
  }));

  return [
    "You are the risk-aware research analyst for a small automated equity/crypto portfolio.",
    "",
    "TASK: analyse how social-media posts by high-profile CEOs and public figures correspond to market patterns, then convert that analysis into concrete trading rules for this system.",
    "",
    `MEASURED EVIDENCE FROM THIS PORTFOLIO'S OWN DATA (last ${summary.window_days} days):`,
    JSON.stringify(summary, null, 1),
    "",
    "SAMPLE EVENTS (post -> forward % move of the mapped symbol):",
    JSON.stringify(sample),
    "",
    "TRACKED PEOPLE AND THE SYMBOLS THEY MAP TO:",
    JSON.stringify(
      TRACKED_EXECUTIVES.map((e) => ({ id: e.id, name: e.name, symbols: e.symbols, prior_weight: e.weight })),
    ),
    "",
    "Combine the measured evidence above with the well-documented history of this phenomenon (product/guidance teases vs. off-topic provocation; posts that move a whole sector vs. one ticker; policy posts that move index and rates rather than a single name; the way an initial spike is often given back within days when no cash-flow news follows; thin-liquidity and out-of-hours amplification; crypto's outsized sensitivity to a single account).",
    "",
    "IMPORTANT: the measured sample here may be small or empty. Where it is, say so plainly, lean on the general history, and keep the confidence and the coefficients conservative rather than inventing an edge.",
    "",
    "Return STRICT JSON only, no markdown fence, shaped as:",
    "{",
    '  "narrative": "<250-450 words of plain-English analysis a non-technical owner can read>",',
    '  "lessons": ["<8-12 short imperative rules the engine should follow>"],',
    '  "coefficient_adjustments": [',
    '    {"executive_id":"musk","stance":"follow|fade|ignore","weight":0.0-1.0,"max_nudge":0.0-0.15,"half_life_hours":6-96,"min_posts":1-5,"note":"<one sentence why>"}',
    "  ]",
    "}",
    "",
    "Rules for the adjustments: only use executive_id values from the tracked list; be explicit about which posts are tradable signal and which are noise; prefer a short half-life for people whose moves reverse; set stance 'ignore' where the evidence says the posts do not move the mapped symbols; never argue for a larger nudge than 0.15 (the hard cap).",
  ].join("\n");
}

function parseJsonBlock(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function fallbackNarrative(summary: ExecPostStudySummary): string {
  if (summary.events === 0) {
    return "No reported executive posts were detected in the window, so there is nothing to measure yet. The engine keeps the catalogued default weights, which cap any single post's influence at 0.15 of a symbol's news score — enough to break a tie between two similar candidates, never enough to open a position on its own.";
  }
  return `Across ${summary.events} post-to-symbol events the next-day move agreed with the post's tone ${Math.round(summary.overall_hit_rate_1d * 100)}% of the time, with an average absolute move of ${summary.overall_mean_abs_1d.toFixed(2)}% and ${Math.round(summary.overall_reversal_rate * 100)}% of the initial moves reversing within a week. The coefficients below follow that record: strength scales with the demonstrated edge, shrunk toward the catalogued prior, and reversal-heavy names get a tighter cap and a shorter half-life.`;
}

function fallbackLessons(summary: ExecPostStudySummary): string[] {
  const base = [
    "Treat a post as a timing tilt on an idea the ranking model already likes, never as a standalone entry.",
    "Cap any single post's influence at 0.15 of a symbol's news score.",
    "Require the venue to be open before acting on a post; out-of-hours reactions gap and fill.",
    "Halve the tilt when the post is off-topic for the company's cash flows (politics, feuds, memes).",
    "Shorten the half-life for people whose moves historically round-trip inside the week.",
    "Never let a post override an active risk halt, drawdown gate or cash floor.",
    "Prefer the primary ticker over sector proxies; second-order symbols get half weight.",
    "Fade rather than follow a person whose posts have a sub-coin-flip next-day hit rate on real sample size.",
  ];
  if (summary.overall_reversal_rate > 0.4) {
    base.push("Reversal rate is high in this sample — take the tilt off after one session rather than holding it.");
  }
  return base;
}

/** Runs the full study for one user and persists the results. */
export async function runExecPostAnalysis(args: {
  supabase: Sb;
  userId: string;
  windowDays: number;
}): Promise<ExecPostStudyResult> {
  const { supabase, userId } = args;
  const windowDays = Math.max(14, Math.min(365, Math.round(args.windowDays)));
  const since = daysAgo(windowDays);

  const posts = await loadDetectedPosts(supabase, since);
  const symbols = Array.from(
    new Set(posts.flatMap((p) => p.symbols.map((s) => s.toUpperCase()))),
  );
  const prices = await loadPriceSeries(supabase, symbols, daysAgo(windowDays + 20));
  const events = buildExecPostEvents(posts, prices);
  const summary = summariseStudy(events, windowDays);

  // Persist the event rows so the study is reproducible and grows over time.
  let persisted = 0;
  if (events.length > 0) {
    const rows = events.map((e) => ({
      user_id: userId,
      executive_id: e.executive_id,
      executive_name: e.executive_name,
      symbol: e.symbol,
      post_date: e.post_date,
      headline: e.headline.slice(0, 500),
      source: e.source,
      url: e.url,
      sentiment: e.sentiment,
      base_price: e.base_price,
      ret_1d: e.ret_1d,
      ret_3d: e.ret_3d,
      ret_5d: e.ret_5d,
      max_adverse_pct: e.max_adverse_pct,
    }));
    const { error } = await supabase
      .from("exec_post_events")
      .upsert(rows, { onConflict: "user_id,executive_id,symbol,post_date,headline" });
    if (!error) persisted = rows.length;
    else console.error("[exec-post-analysis] event upsert failed", error.message);
  }

  const derived = deriveCoefficients(summary);

  let narrative = fallbackNarrative(summary);
  let lessons = fallbackLessons(summary);
  let coefficients: ExecPostCoefficient[] = derived;
  let model: string | null = null;
  let aiError: string | null = null;

  const key = process.env["LOVABLE_API_KEY"];
  if (key) {
    try {
      const gateway = createLovableAiGatewayProvider(key);
      const { text } = await generateText({
        model: gateway(MODEL),
        prompt: buildPrompt(summary, events),
        temperature: 0.3,
      });
      const parsed = parseJsonBlock(text);
      if (parsed) {
        const n = typeof parsed["narrative"] === "string" ? (parsed["narrative"] as string).trim() : "";
        if (n.length > 40) narrative = n;
        const ls = Array.isArray(parsed["lessons"])
          ? (parsed["lessons"] as unknown[])
              .filter((l): l is string => typeof l === "string" && l.trim().length > 0)
              .map((l) => l.trim().slice(0, 220))
          : [];
        if (ls.length > 0) lessons = ls.slice(0, 14);
        const adjustments = Array.isArray(parsed["coefficient_adjustments"])
          ? (parsed["coefficient_adjustments"] as ExecPostCoefficientAdjustment[])
          : [];
        coefficients = mergeCoefficientAdjustments(derived, adjustments);
        model = MODEL;
      } else {
        aiError = "Model returned unparseable JSON; kept the measured coefficients.";
      }
    } catch (err) {
      aiError = err instanceof Error ? err.message : String(err);
      console.error("[exec-post-analysis] AI pass failed", aiError);
    }
  } else {
    aiError = "LOVABLE_API_KEY is not configured; used the deterministic study only.";
  }

  const lessonSet: ExecPostLessonSet = {
    generated_at: new Date().toISOString(),
    window_days: windowDays,
    sample_size: events.length,
    model,
    narrative,
    lessons,
    coefficients,
  };

  // Only one lesson set is live at a time; the engine reads the active row.
  await supabase
    .from("exec_post_lessons")
    .update({ active: false })
    .eq("user_id", userId)
    .eq("active", true);

  const { error: insertError } = await supabase.from("exec_post_lessons").insert({
    user_id: userId,
    window_days: windowDays,
    sample_size: events.length,
    model,
    stats: summary as unknown as Record<string, unknown>,
    narrative,
    lessons,
    coefficients: coefficients as unknown as Record<string, unknown>,
    active: true,
  });
  if (insertError) {
    console.error("[exec-post-analysis] lesson insert failed", insertError.message);
    aiError = aiError ?? `Could not save the lessons: ${insertError.message}`;
  }

  return { summary, events, lessons: lessonSet, persisted_events: persisted, ai_error: aiError };
}

/** Active lesson set for a user, or null when the study has never been run. */
export async function loadActiveExecPostLessons(
  supabase: Sb,
  userId: string,
): Promise<ExecPostLessonSet | null> {
  const { data } = await supabase
    .from("exec_post_lessons")
    .select("generated_at, window_days, sample_size, model, narrative, lessons, coefficients")
    .eq("user_id", userId)
    .eq("active", true)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    generated_at: String(row["generated_at"] ?? new Date().toISOString()),
    window_days: Number(row["window_days"] ?? 90),
    sample_size: Number(row["sample_size"] ?? 0),
    model: (row["model"] as string | null) ?? null,
    narrative: (row["narrative"] as string | null) ?? "",
    lessons: Array.isArray(row["lessons"]) ? (row["lessons"] as string[]) : [],
    coefficients: Array.isArray(row["coefficients"])
      ? (row["coefficients"] as ExecPostCoefficient[])
      : [],
  };
}
