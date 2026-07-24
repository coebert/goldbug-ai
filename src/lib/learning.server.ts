// Continuous-learning layer: turns the portfolio's own trade history into
// (a) rolling outcome statistics and (b) short natural-language lessons the
// AI reads back at the top of every day's prompt.

import { generateText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { getPriceOn } from "./market-data.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type LearningStats = {
  window_days: number;
  horizon_days: number;
  evaluable: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  avg_return_pct: number | null;
  best: { symbol: string; return_pct: number } | null;
  worst: { symbol: string; return_pct: number } | null;
  per_symbol: { symbol: string; n: number; win_rate: number; avg_return_pct: number }[];
  per_side: { buy: { n: number; win_rate: number | null }; sell: { n: number; win_rate: number | null } };
};

export type LearningContext = {
  stats: LearningStats;
  lessons: string[];
  lessons_as_of: string | null;
  lessons_regime: string | null; // which regime these lessons were authored under (null = general)
  per_regime_stats: { regime: string; n: number; win_rate: number; avg_return_pct: number }[];
  current_regime: string | null;
  samples: {
    symbol: string;
    side: "buy" | "sell";
    trade_date: string;
    entry_price: number;
    exit_price: number;
    return_pct: number;
    outcome: "win" | "loss";
    reason: string | null;
    regime: string | null;
  }[];
};

async function resolveUserId(portfolioId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("portfolios")
    .select("user_id")
    .eq("id", portfolioId)
    .maybeSingle();
  return (data?.user_id as string | undefined) ?? null;
}

async function listUserPortfolioIds(userId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("portfolios")
    .select("id")
    .eq("user_id", userId);
  return (data ?? []).map((r) => r.id as string);
}

export async function computeRecentOutcomes(
  portfolioId: string,
  asOf: string,
  windowDays = 20,
  horizonDays = 5,
): Promise<Pick<LearningContext, "stats" | "samples">> {
  // Pool trades across ALL of this user's portfolios so lessons carry over
  // between portfolios (and survive deletion of any single one).
  const since = new Date(asOf);
  since.setDate(since.getDate() - Math.ceil(windowDays * 1.7));
  const sinceStr = since.toISOString().slice(0, 10);

  const userId = await resolveUserId(portfolioId);
  const portfolioIds = userId ? await listUserPortfolioIds(userId) : [portfolioId];
  const scopeIds = portfolioIds.length ? portfolioIds : [portfolioId];

  const [{ data: trades }, { data: regimeRows }] = await Promise.all([
    supabaseAdmin
      .from("trades")
      .select("symbol, side, price, trade_date, reason")
      .in("portfolio_id", scopeIds)
      .gte("trade_date", sinceStr)
      .lte("trade_date", asOf)
      .order("trade_date", { ascending: true }),
    supabaseAdmin
      .from("market_regimes")
      .select("as_of, regime")
      .gte("as_of", sinceStr)
      .lte("as_of", asOf)
      .order("as_of", { ascending: true }),
  ]);

  // Build a step-function of regime by date; each trade_date snaps to the
  // most-recent regime observation on or before it.
  const regimeSeries: { d: string; r: string }[] = (regimeRows ?? []).map((row) => ({
    d: row.as_of as string,
    r: row.regime as string,
  }));
  function regimeFor(dateStr: string): string | null {
    if (regimeSeries.length === 0) return null;
    let match: string | null = null;
    for (const p of regimeSeries) {
      if (p.d <= dateStr) match = p.r;
      else break;
    }
    return match;
  }

  const samples: LearningContext["samples"] = [];
  for (const t of trades ?? []) {
    const entry = Number(t.price);
    if (!Number.isFinite(entry) || entry <= 0) continue;

    // "Exit" reference point: horizon-days after the trade, capped at asOf.
    const tradeDate = new Date(t.trade_date);
    const target = new Date(tradeDate);
    target.setDate(target.getDate() + horizonDays);
    const exitDate = target > new Date(asOf) ? asOf : target.toISOString().slice(0, 10);

    const exit = await getPriceOn(t.symbol, exitDate).catch(() => null);
    if (exit == null || exit <= 0) continue;

    // For a BUY, positive forward return = good decision.
    // For a SELL, positive forward return means we sold too early; flip sign.
    const rawReturn = (exit - entry) / entry;
    const signed = t.side === "buy" ? rawReturn : -rawReturn;

    samples.push({
      symbol: t.symbol,
      side: t.side as "buy" | "sell",
      trade_date: t.trade_date,
      entry_price: entry,
      exit_price: exit,
      return_pct: signed * 100,
      outcome: signed >= 0 ? "win" : "loss",
      reason: t.reason ?? null,
      regime: regimeFor(t.trade_date),
    });
  }

  const evaluable = samples.length;
  const wins = samples.filter((s) => s.outcome === "win").length;
  const losses = evaluable - wins;
  const winRate = evaluable > 0 ? wins / evaluable : null;
  const avgReturn = evaluable > 0
    ? samples.reduce((a, b) => a + b.return_pct, 0) / evaluable
    : null;

  const best = samples.length
    ? samples.reduce((a, b) => (b.return_pct > a.return_pct ? b : a))
    : null;
  const worst = samples.length
    ? samples.reduce((a, b) => (b.return_pct < a.return_pct ? b : a))
    : null;

  const bySymbol = new Map<string, LearningContext["samples"]>();
  for (const s of samples) {
    if (!bySymbol.has(s.symbol)) bySymbol.set(s.symbol, []);
    bySymbol.get(s.symbol)!.push(s);
  }
  const perSymbol = Array.from(bySymbol.entries())
    .map(([symbol, arr]) => ({
      symbol,
      n: arr.length,
      win_rate: arr.filter((x) => x.outcome === "win").length / arr.length,
      avg_return_pct: arr.reduce((a, b) => a + b.return_pct, 0) / arr.length,
    }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);

  const sideStats = (side: "buy" | "sell") => {
    const arr = samples.filter((s) => s.side === side);
    return arr.length
      ? { n: arr.length, win_rate: arr.filter((x) => x.outcome === "win").length / arr.length }
      : { n: 0, win_rate: null };
  };

  return {
    samples,
    stats: {
      window_days: windowDays,
      horizon_days: horizonDays,
      evaluable,
      wins,
      losses,
      win_rate: winRate,
      avg_return_pct: avgReturn,
      best: best
        ? { symbol: best.symbol, return_pct: best.return_pct }
        : null,
      worst: worst
        ? { symbol: worst.symbol, return_pct: worst.return_pct }
        : null,
      per_symbol: perSymbol,
      per_side: { buy: sideStats("buy"), sell: sideStats("sell") },
    },
  };
}

async function fetchLatestLessons(userId: string, currentRegime: string | null) {
  // Lessons are pooled per USER, not per portfolio, so they persist across
  // every portfolio the user owns and survive portfolio deletion.
  async function grab(regime: string | null) {
    const q = supabaseAdmin
      .from("portfolio_lessons")
      .select("as_of, lessons, regime")
      .eq("user_id", userId)
      .order("as_of", { ascending: false })
      .limit(1);
    const { data } = await (regime == null ? q.is("regime", null) : q.eq("regime", regime)).maybeSingle();
    if (!data) return null;
    const raw = (data.lessons as unknown) ?? [];
    const lessons = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    if (!lessons.length) return null;
    return { lessons, as_of: (data.as_of as string | undefined) ?? null, regime: (data.regime as string | null) ?? null };
  }
  const scoped = currentRegime ? await grab(currentRegime) : null;
  const general = scoped ? null : await grab(null);
  const hit = scoped ?? general;
  return {
    lessons: hit?.lessons ?? [],
    lessons_as_of: hit?.as_of ?? null,
    lessons_regime: hit?.regime ?? null,
  };
}

async function currentRegimeFor(asOf: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("market_regimes")
    .select("regime")
    .lte("as_of", asOf)
    .order("as_of", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.regime as string | null) ?? null;
}

export async function buildLearningContext(
  portfolioId: string,
  asOf: string,
): Promise<LearningContext> {
  const current_regime = await currentRegimeFor(asOf);
  const userId = await resolveUserId(portfolioId);
  const [{ stats, samples }, lessonHit] = await Promise.all([
    computeRecentOutcomes(portfolioId, asOf),
    userId
      ? fetchLatestLessons(userId, current_regime)
      : Promise.resolve({ lessons: [] as string[], lessons_as_of: null, lessons_regime: null }),
  ]);
  // Per-regime rolling stats from the same sample window.
  const buckets = new Map<string, LearningContext["samples"]>();
  for (const s of samples) {
    if (!s.regime) continue;
    if (!buckets.has(s.regime)) buckets.set(s.regime, []);
    buckets.get(s.regime)!.push(s);
  }
  const per_regime_stats = Array.from(buckets.entries())
    .map(([regime, arr]) => ({
      regime,
      n: arr.length,
      win_rate: arr.filter((x) => x.outcome === "win").length / arr.length,
      avg_return_pct: arr.reduce((a, b) => a + b.return_pct, 0) / arr.length,
    }))
    .sort((a, b) => b.n - a.n);
  return { stats, samples, ...lessonHit, per_regime_stats, current_regime };
}

export function formatLearningBlock(ctx: LearningContext): string {
  const s = ctx.stats;
  if (s.evaluable === 0 && ctx.lessons.length === 0) {
    return `LEARNING MEMORY: No prior trades to learn from yet. Be extra cautious on the first few days and prefer diversified ETF exposure until a track record exists.`;
  }
  const wr = s.win_rate != null ? `${(s.win_rate * 100).toFixed(0)}%` : "n/a";
  const ar = s.avg_return_pct != null ? `${s.avg_return_pct.toFixed(2)}%` : "n/a";
  const perSym = s.per_symbol
    .slice(0, 5)
    .map(
      (p) =>
        `${p.symbol}: ${p.n} trades, ${(p.win_rate * 100).toFixed(0)}% win, avg ${p.avg_return_pct.toFixed(2)}%`,
    )
    .join("; ");
  const regimeTag = ctx.lessons_regime
    ? `regime-conditioned on "${ctx.lessons_regime}"`
    : "general (no regime match yet)";
  const lessonsBlock = ctx.lessons.length
    ? `Lessons learned so far (self-authored, ${regimeTag}, last updated ${ctx.lessons_as_of ?? "n/a"}):\n${ctx.lessons.map((l, i) => `  ${i + 1}. ${l}`).join("\n")}`
    : "Not enough evaluable trades yet to author lessons.";
  const perRegime = ctx.per_regime_stats.length
    ? ctx.per_regime_stats
        .map((p) => `${p.regime}: ${p.n} trades, ${(p.win_rate * 100).toFixed(0)}% win, avg ${p.avg_return_pct.toFixed(2)}%`)
        .join("; ")
    : "n/a";
  return `LEARNING MEMORY (rolling outcomes over the last ${s.window_days} days, forward-return horizon ${s.horizon_days}d):
- Current market regime: ${ctx.current_regime ?? "unknown"} — lessons below are ${regimeTag}.
- Evaluable trades: ${s.evaluable} (wins ${s.wins} / losses ${s.losses}) — win rate ${wr}, average return ${ar}
- Best call: ${s.best ? `${s.best.symbol} (${s.best.return_pct.toFixed(2)}%)` : "n/a"} | Worst call: ${s.worst ? `${s.worst.symbol} (${s.worst.return_pct.toFixed(2)}%)` : "n/a"}
- Per symbol: ${perSym || "n/a"}
- Per regime: ${perRegime}
- By side — buys: ${s.per_side.buy.n} (win ${s.per_side.buy.win_rate != null ? `${(s.per_side.buy.win_rate * 100).toFixed(0)}%` : "n/a"}), sells: ${s.per_side.sell.n} (win ${s.per_side.sell.win_rate != null ? `${(s.per_side.sell.win_rate * 100).toFixed(0)}%` : "n/a"})
${lessonsBlock}

Apply these lessons carefully: they were derived from the regime named above, so weight them heavier when the current regime matches and treat them as weaker priors when it doesn't. Double-check any move that repeats a losing pattern, and lean into approaches with a demonstrated edge in this regime. State in your rationale whenever a decision was directly informed by a specific lesson.`;
}

const LessonsSchema = z.object({
  lessons: z.array(z.string()),
});

export async function reflectAndUpdateLessons(
  portfolioId: string,
  asOf: string,
  ctx: LearningContext,
): Promise<{ updated: boolean; reason?: string; regimes?: string[] }> {
  const userId = await resolveUserId(portfolioId);
  if (!userId) return { updated: false, reason: "portfolio has no owner" };
  if (ctx.stats.evaluable < 5) return { updated: false, reason: "not enough evaluable trades" };
  if (ctx.lessons_as_of) {
    const daysSince =
      (new Date(asOf).getTime() - new Date(ctx.lessons_as_of).getTime()) /
      (1000 * 60 * 60 * 24);
    if (daysSince < 3) return { updated: false, reason: "recently reflected" };
  }

  const key = process.env.LOVABLE_API_KEY;
  if (!key) return { updated: false, reason: "no ai key" };
  const gateway = createLovableAiGatewayProvider(key);
  const model = gateway("google/gemini-3.6-flash");

  // Build one bucket per regime with ≥3 samples, plus a "general" bucket over
  // all samples so newly-entered regimes still have a fallback lesson set.
  type Bucket = { regime: string | null; samples: LearningContext["samples"] };
  const byRegime = new Map<string, LearningContext["samples"]>();
  for (const s of ctx.samples) {
    if (!s.regime) continue;
    if (!byRegime.has(s.regime)) byRegime.set(s.regime, []);
    byRegime.get(s.regime)!.push(s);
  }
  const buckets: Bucket[] = [{ regime: null, samples: ctx.samples }];
  for (const [regime, arr] of byRegime.entries()) {
    if (arr.length >= 3) buckets.push({ regime, samples: arr });
  }

  const writtenRegimes: string[] = [];
  for (const b of buckets) {
    const sampleLines = b.samples
      .slice(-25)
      .map(
        (s) =>
          `${s.trade_date} [${s.regime ?? "unknown"}] ${s.side.toUpperCase()} ${s.symbol} @ ${s.entry_price.toFixed(2)} → ${s.exit_price.toFixed(2)} (${s.return_pct.toFixed(2)}%, ${s.outcome})${s.reason ? ` — reason: "${s.reason}"` : ""}`,
      )
      .join("\n");

    const regimeIntro = b.regime
      ? `You are reviewing this portfolio's trades that occurred specifically during the "${b.regime}" market regime. Produce lessons that are only applied when this regime is active again.`
      : `You are reviewing this portfolio's trades across all recent market regimes. Produce general-purpose lessons that apply when no regime-specific lesson exists.`;

    const system = `You are the portfolio's post-trade review analyst. ${regimeIntro} Produce 3–5 short lessons — each one concrete, testable, and actionable on future days. Prefer specific patterns ("BUY calls on tech ETFs after RSI<30 in bull_quiet returned +2.1% avg") over generic advice.`;

    const prior = b.regime && ctx.lessons_regime === b.regime && ctx.lessons.length
      ? `Prior lessons for this regime (may be kept, revised, or dropped):\n${ctx.lessons.map((l, i) => `${i + 1}. ${l}`).join("\n")}`
      : "No prior lessons for this regime yet.";

    const user = `Date: ${asOf}
Bucket: ${b.regime ?? "general"} (${b.samples.length} trades)

Recent trades and outcomes:
${sampleLines || "(none)"}

${prior}

Return { lessons: string[] } with 3–5 items, each under 180 characters. Use plain English.`;

    try {
      const { output } = await generateText({
        model,
        system,
        prompt: user,
        output: Output.object({ schema: LessonsSchema }),
      });
      const lessons = (output.lessons ?? [])
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(0, 5);
      if (lessons.length === 0) continue;

      await supabaseAdmin.from("portfolio_lessons").insert({
        user_id: userId,
        portfolio_id: portfolioId,
        as_of: asOf,
        lessons,
        stats: ctx.stats as unknown as never,
        window_days: ctx.stats.window_days,
        regime: b.regime,
      });
      writtenRegimes.push(b.regime ?? "general");
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) continue;
      throw error;
    }
  }

  if (writtenRegimes.length === 0) return { updated: false, reason: "no buckets produced lessons" };
  return { updated: true, regimes: writtenRegimes };
}
