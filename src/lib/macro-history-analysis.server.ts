// Server-only: runs the 20-year news ↔ market-pattern study, asks the AI to
// interpret it, and persists the resulting playbook.
//
// Deterministic half: `macro-history.ts` measures the real index series in
// price_cache (drawdowns, recoveries, forward returns by depth and by
// volatility regime) and the response of the index to each typed news-event
// kind in news_cache.
//
// AI half: writes the narrative and the lesson list, and proposes adjustments
// to the derived playbook — every number is re-clamped by
// `mergePlaybookAdjustments` before it can reach the trading engine.

import { generateText } from "ai";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { classifyHeadline } from "./market-events";
import { formatGlobalEventBlock, studyGlobalEvents } from "./global-event-study";
import {
  analyseIndexHistory,
  measureKindResponses,
  MACRO_EPISODES,
  type IndexBar,
  type MacroHistoryStudy,
} from "./macro-history";
import {
  derivePlaybook,
  deriveDrawdownRules,
  mergeDrawdownRuleAdjustments,
  mergePlaybookAdjustments,
  type MacroDrawdownRule,
  type MacroLessonSet,
  type MacroPlaybookAdjustment,
  type MacroPlaybookEntry,
} from "./macro-playbook";


const MODEL = "google/gemini-2.5-pro";
const PRIMARY_INDEX = "SPY";
const SECONDARY_INDEX = "QQQ";

type Sb = { from: (table: string) => any };

export type MacroStudyResult = {
  study: MacroHistoryStudy;
  lessons: MacroLessonSet;
  ai_error: string | null;
};

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Full available close history for one index symbol, ascending. */
export async function loadIndexHistory(supabase: Sb, symbol: string): Promise<IndexBar[]> {
  const out: IndexBar[] = [];
  const page = 1000;
  for (let offset = 0; offset < 20000; offset += page) {
    const { data, error } = await supabase
      .from("price_cache")
      .select("price_date, close")
      .eq("symbol", symbol)
      .order("price_date", { ascending: true })
      .range(offset, offset + page - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data as Array<Record<string, unknown>>) {
      const close = Number(row["close"]);
      if (Number.isFinite(close) && close > 0) {
        out.push({ date: String(row["price_date"]).slice(0, 10), close });
      }
    }
    if (data.length < page) break;
  }
  return out;
}

/** ISO date → typed event kinds seen in the news that day. */
export async function loadEventDays(
  supabase: Sb,
  sinceDate: string,
): Promise<{ days: Map<string, string[]>; headlines: number }> {
  const days = new Map<string, string[]>();
  let headlines = 0;
  const page = 1000;

  for (let offset = 0; offset < 20000; offset += page) {
    const { data, error } = await supabase
      .from("news_cache")
      .select("news_date, headline")
      .gte("news_date", sinceDate)
      .order("news_date", { ascending: true })
      .range(offset, offset + page - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data as Array<Record<string, unknown>>) {
      headlines++;
      const date = String(row["news_date"] ?? "").slice(0, 10);
      const kinds = classifyHeadline(String(row["headline"] ?? ""));
      if (!date || kinds.length === 0) continue;
      const list = days.get(date) ?? [];
      for (const k of kinds) if (!list.includes(k)) list.push(k);
      days.set(date, list);
    }
    if (data.length < page) break;
  }
  return { days, headlines };
}

export function buildMacroPrompt(study: MacroHistoryStudy, derived: MacroPlaybookEntry[], rules: MacroDrawdownRule[]): string {
  return [
    "You are the head of research for a small automated equity/crypto portfolio. You are writing the house macro playbook.",
    "",
    "TASK: analyse how global news over the last ~20 years corresponded to market patterns, and turn that analysis into concrete, bounded rules this engine will apply to every future buy/sell decision.",
    "",
    "A. MEASURED INDEX HISTORY (computed from this system's own price data, not from memory):",
    JSON.stringify(
      {
        index: study.index,
        secondary: study.secondary
          ? { symbol: study.secondary.symbol, years: study.secondary.years, cagr_pct: study.secondary.cagr_pct, max_drawdown_pct: study.secondary.max_drawdown_pct }
          : null,
      },
      null,
      1,
    ),
    "",
    "B. DOCUMENTED MACRO EPISODES SINCE 2005 (catalogue: drawdown, recovery time, origin, transferable lesson):",
    JSON.stringify(MACRO_EPISODES),
    "",
    "B2. THE CURATED GLOBAL EVENT REEL (1975→today), each event measured event-by-event against this system's own index series — run-up into the event, fall inside the window, days back to the old high, and forward returns 20/60/250 sessions after the window closed. Study every row: this is the longest evidence base available and it covers episodes the 2005 catalogue does not (Black Monday, the Gulf War, the Asian crisis, LTCM, the dot-com bust, 9/11).",
    JSON.stringify(
      study.global_events
        ? {
            coverage: {
              measured: study.global_events.events_measured,
              total: study.global_events.events_total,
              from: study.global_events.from,
              to: study.global_events.to,
            },
            by_category: study.global_events.categories,
            severe: study.global_events.severe,
            events: study.global_events.measurements.filter((m) => m.covered),
            uncovered: study.global_events.measurements.filter((m) => !m.covered).map((m) => m.id),
          }
        : null,
    ),
    "",

    `C. MEASURED INDEX RESPONSE TO TYPED NEWS EVENTS (only ${study.news_window_days} days of stored news, so this sample is thin):`,
    JSON.stringify(study.kind_responses),
    "",
    "D. THE PLAYBOOK DERIVED DETERMINISTICALLY FROM A+B+C (your starting point):",
    JSON.stringify(derived),
    "",
    "E. DRAWDOWN SIZING RULES DERIVED FROM THE FORWARD-RETURN BUCKETS:",
    JSON.stringify(rules),
    "",
    "Reason across the whole 20-year record, not just the measured sample: which news categories were genuine repricings that extended (rate cuts and inflation surprises into a trend), which were noise that round-tripped inside weeks (single geopolitical headlines, liquidity air-pockets, most political shocks), and which were the early tell of a slow credit-origin bear where capital preservation beat dip-buying (2008, 2022). Note explicitly how the recovery time differed by origin — exogenous shocks met with policy support recovered in months (2020: 33.9% in 33 days, recovered in ~5 months), credit-origin bears took years (2008: 56.8%, ~4 years).",
    "",
    "IMPORTANT: section C is a very small sample. Do not overfit to it. Where it disagrees with the 20-year record, prefer the record and say so.",
    "",
    "Return STRICT JSON only, no markdown fence, shaped as:",
    "{",
    '  "narrative": "<350-600 words of plain-English analysis the portfolio owner can read: what news actually predicted, what it did not, and how this changes the engine\'s behaviour>",',
    '  "lessons": ["<10-14 short imperative rules the engine should follow>"],',
    '  "playbook_adjustments": [',
    '    {"kind":"rate_cut","response":"follow|fade|wait|de_risk","tilt_multiplier":0.0-2.0,"half_life_hours":6-336,"confirm_sessions":0-5,"note":"<one sentence of evidence>"}',
    "  ],",
    '  "drawdown_rule_adjustments": [',
    '    {"from_pct":0|2|5|10|20,"size_scale":0.2-1.5,"require_trend":true|false,"note":"<one sentence>"}',
    "  ]",
    "}",
    "",
    'Rules: only use "kind" values that already appear in section D; keep tilt_multiplier ≤ 2.0 and size_scale ≤ 1.5 (hard caps, larger values are clamped away); prefer a shorter half-life for kinds that historically round-tripped; be explicit about which categories are tradable and which are noise.',
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

function fallbackNarrative(study: MacroHistoryStudy): string {
  const idx = study.index;
  return [
    `Across ${idx.years} years of ${idx.symbol} history the index compounded at ${idx.cagr_pct}% a year with ${idx.vol_pct}% annualised volatility, and gave back ${idx.max_drawdown_pct}% at its worst.`,
    `There were ${idx.episodes.length} drawdowns of 8% or more in the sample; the ones deeper than 10% took a median of ${idx.median_recovery_days ?? "n/a"} calendar days to make a new high.`,
    "The documented episode catalogue separates them by origin, and origin — not depth — is what determined recovery time: policy-supported exogenous shocks (2020, 2011, 2016) recovered in weeks to months, while credit-origin bears (2008) and rate-shock bears (2022) took one to four years and punished every early dip-buy.",
    "The engine therefore treats a headline as a prior on an idea the ranking model already likes, sizes buys by how deep the index already is, and switches from dip-buying to capital preservation when the event kind is one of the credit/inflation categories that historically led the slow bears.",
  ].join(" ");
}

function fallbackLessons(study: MacroHistoryStudy): string[] {
  const deep = study.index.buckets.find((b) => b.bucket_from === 5);
  const base = [
    "Classify the news before reacting to it: origin decides the response, not the size of the headline.",
    "Buy dips in the 2-10% band by default; that is where the measured forward return was best per unit of risk.",
    "Beyond a 20% drawdown, require a confirmed uptrend before adding — deep holes were where early buyers were punished worst.",
    "Treat credit downgrades, hot inflation prints and recession signals as de-risk triggers, not dip-buying opportunities.",
    "Fade single geopolitical headlines and liquidity air-pockets with no cash-flow transmission; they round-tripped within weeks.",
    "Require price confirmation on tariff and rate-decision headlines; direction from the headline alone was unreliable.",
    "Never let a macro tilt exceed 0.2 of a symbol's news score — it sharpens a view, it never creates one.",
    "Policy support, not valuation, marked the bottoms; wait for the policy turn rather than forecasting it.",
    "Shorten the holding horizon of any tilt whose historical move reversed by day 20.",
    "Keep the cash floor and drawdown gates above every macro conviction, however strong the narrative reads.",
  ];
  if (deep && deep.fwd_3m.samples > 20) {
    base.push(
      `From 5-10% below the high the 3-month forward return averaged ${deep.fwd_3m.mean_pct}% with a ${Math.round(deep.fwd_3m.hit_rate * 100)}% hit rate — size up there, not at the highs.`,
    );
  }
  return base;
}

/** Runs the full 20-year study for one user and persists the playbook. */
export async function runMacroHistoryAnalysis(args: {
  supabase: Sb;
  userId: string;
  newsWindowDays?: number;
}): Promise<MacroStudyResult> {
  const { supabase, userId } = args;
  const newsWindowDays = Math.max(7, Math.min(3650, Math.round(args.newsWindowDays ?? 365)));

  const [primary, secondary, news] = await Promise.all([
    loadIndexHistory(supabase, PRIMARY_INDEX),
    loadIndexHistory(supabase, SECONDARY_INDEX).catch(() => [] as IndexBar[]),
    loadEventDays(supabase, daysAgo(newsWindowDays)),
  ]);

  const index = analyseIndexHistory(PRIMARY_INDEX, primary);
  const study: MacroHistoryStudy = {
    generated_at: new Date().toISOString(),
    index,
    secondary: secondary.length > 30 ? analyseIndexHistory(SECONDARY_INDEX, secondary) : null,
    kind_responses: measureKindResponses(news.days, primary),
    episodes: MACRO_EPISODES,
    news_window_days: newsWindowDays,
    news_events: news.days.size,
  };

  const derivedPlaybook = derivePlaybook(study);
  const derivedRules = deriveDrawdownRules(study);

  let narrative = fallbackNarrative(study);
  let lessons = fallbackLessons(study);
  let playbook = derivedPlaybook;
  let drawdownRules = derivedRules;
  let model: string | null = null;
  let aiError: string | null = null;

  const key = process.env["LOVABLE_API_KEY"];
  if (key) {
    try {
      const gateway = createLovableAiGatewayProvider(key);
      const { text } = await generateText({
        model: gateway(MODEL),
        prompt: buildMacroPrompt(study, derivedPlaybook, derivedRules),
        temperature: 0.3,
      });
      const parsed = parseJsonBlock(text);
      if (parsed) {
        const n = typeof parsed["narrative"] === "string" ? (parsed["narrative"] as string).trim() : "";
        if (n.length > 60) narrative = n;
        const ls = Array.isArray(parsed["lessons"])
          ? (parsed["lessons"] as unknown[])
              .filter((l): l is string => typeof l === "string" && l.trim().length > 0)
              .map((l) => l.trim().slice(0, 240))
          : [];
        if (ls.length > 0) lessons = ls.slice(0, 16);
        playbook = mergePlaybookAdjustments(
          derivedPlaybook,
          Array.isArray(parsed["playbook_adjustments"])
            ? (parsed["playbook_adjustments"] as MacroPlaybookAdjustment[])
            : [],
        );
        drawdownRules = mergeDrawdownRuleAdjustments(
          derivedRules,
          Array.isArray(parsed["drawdown_rule_adjustments"])
            ? (parsed["drawdown_rule_adjustments"] as Array<{ from_pct?: number; size_scale?: number; require_trend?: boolean; note?: string }>)
            : [],
        );
        model = MODEL;
      } else {
        aiError = "Model returned unparseable JSON; kept the measured playbook.";
      }
    } catch (err) {
      aiError = err instanceof Error ? err.message : String(err);
      console.error("[macro-history-analysis] AI pass failed", aiError);
    }
  } else {
    aiError = "LOVABLE_API_KEY is not configured; used the deterministic study only.";
  }

  const lessonSet: MacroLessonSet = {
    generated_at: new Date().toISOString(),
    model,
    years_covered: index.years,
    episodes: index.episodes.length,
    narrative,
    lessons,
    playbook,
    drawdown_rules: drawdownRules,
  };

  await supabase.from("macro_lessons").update({ active: false }).eq("user_id", userId).eq("active", true);

  const { error: insertError } = await supabase.from("macro_lessons").insert({
    user_id: userId,
    years_covered: index.years,
    episodes: index.episodes.length,
    news_window_days: newsWindowDays,
    model,
    stats: study as unknown as Record<string, unknown>,
    narrative,
    lessons,
    playbook: playbook as unknown as Record<string, unknown>,
    drawdown_rules: drawdownRules as unknown as Record<string, unknown>,
    active: true,
  });
  if (insertError) {
    console.error("[macro-history-analysis] lesson insert failed", insertError.message);
    aiError = aiError ?? `Could not save the playbook: ${insertError.message}`;
  }

  return { study, lessons: lessonSet, ai_error: aiError };
}

/** Active macro playbook for a user, or null when the study has never been run. */
export async function loadActiveMacroLessons(
  supabase: Sb,
  userId: string,
): Promise<MacroLessonSet | null> {
  const { data } = await supabase
    .from("macro_lessons")
    .select("generated_at, years_covered, episodes, model, narrative, lessons, playbook, drawdown_rules")
    .eq("user_id", userId)
    .eq("active", true)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    generated_at: String(row["generated_at"] ?? new Date().toISOString()),
    model: (row["model"] as string | null) ?? null,
    years_covered: Number(row["years_covered"] ?? 0),
    episodes: Number(row["episodes"] ?? 0),
    narrative: (row["narrative"] as string | null) ?? "",
    lessons: Array.isArray(row["lessons"]) ? (row["lessons"] as string[]) : [],
    playbook: Array.isArray(row["playbook"]) ? (row["playbook"] as MacroPlaybookEntry[]) : [],
    drawdown_rules: Array.isArray(row["drawdown_rules"])
      ? (row["drawdown_rules"] as MacroDrawdownRule[])
      : [],
  };
}
