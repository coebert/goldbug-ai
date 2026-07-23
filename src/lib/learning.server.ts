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

export async function computeRecentOutcomes(
  portfolioId: string,
  asOf: string,
  windowDays = 20,
  horizonDays = 5,
): Promise<Pick<LearningContext, "stats" | "samples">> {
  // Fetch trades in a slightly wider calendar window (to cover weekends).
  const since = new Date(asOf);
  since.setDate(since.getDate() - Math.ceil(windowDays * 1.7));
  const sinceStr = since.toISOString().slice(0, 10);

  const { data: trades } = await supabaseAdmin
    .from("trades")
    .select("symbol, side, price, trade_date, reason")
    .eq("portfolio_id", portfolioId)
    .gte("trade_date", sinceStr)
    .lte("trade_date", asOf)
    .order("trade_date", { ascending: true });

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

async function fetchLatestLessons(portfolioId: string) {
  const { data } = await supabaseAdmin
    .from("portfolio_lessons")
    .select("as_of, lessons")
    .eq("portfolio_id", portfolioId)
    .order("as_of", { ascending: false })
    .limit(1)
    .maybeSingle();
  const raw = (data?.lessons as unknown) ?? [];
  const lessons = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  return { lessons, lessons_as_of: (data?.as_of as string | undefined) ?? null };
}

export async function buildLearningContext(
  portfolioId: string,
  asOf: string,
): Promise<LearningContext> {
  const [{ stats, samples }, { lessons, lessons_as_of }] = await Promise.all([
    computeRecentOutcomes(portfolioId, asOf),
    fetchLatestLessons(portfolioId),
  ]);
  return { stats, samples, lessons, lessons_as_of };
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
  const lessonsBlock = ctx.lessons.length
    ? `Lessons learned so far (self-authored, last updated ${ctx.lessons_as_of ?? "n/a"}):\n${ctx.lessons.map((l, i) => `  ${i + 1}. ${l}`).join("\n")}`
    : "Not enough evaluable trades yet to author lessons.";
  return `LEARNING MEMORY (rolling outcomes over the last ${s.window_days} days, forward-return horizon ${s.horizon_days}d):
- Evaluable trades: ${s.evaluable} (wins ${s.wins} / losses ${s.losses}) — win rate ${wr}, average return ${ar}
- Best call: ${s.best ? `${s.best.symbol} (${s.best.return_pct.toFixed(2)}%)` : "n/a"} | Worst call: ${s.worst ? `${s.worst.symbol} (${s.worst.return_pct.toFixed(2)}%)` : "n/a"}
- Per symbol: ${perSym || "n/a"}
- By side — buys: ${s.per_side.buy.n} (win ${s.per_side.buy.win_rate != null ? `${(s.per_side.buy.win_rate * 100).toFixed(0)}%` : "n/a"}), sells: ${s.per_side.sell.n} (win ${s.per_side.sell.win_rate != null ? `${(s.per_side.sell.win_rate * 100).toFixed(0)}%` : "n/a"})
${lessonsBlock}

Apply these lessons: double-check any move that repeats a losing pattern, and lean into approaches with a demonstrated edge. State in your rationale whenever a decision was directly informed by a specific lesson.`;
}

const LessonsSchema = z.object({
  lessons: z.array(z.string()),
});

export async function reflectAndUpdateLessons(
  portfolioId: string,
  asOf: string,
  ctx: LearningContext,
): Promise<{ updated: boolean; reason?: string }> {
  // Only reflect when we have enough data and it's been a few days.
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

  const sampleLines = ctx.samples
    .slice(-25)
    .map(
      (s) =>
        `${s.trade_date} ${s.side.toUpperCase()} ${s.symbol} @ ${s.entry_price.toFixed(2)} → ${s.exit_price.toFixed(2)} (${s.return_pct.toFixed(2)}%, ${s.outcome})${s.reason ? ` — reason: "${s.reason}"` : ""}`,
    )
    .join("\n");

  const system = `You are the portfolio's own post-trade review analyst. Study its last ${ctx.stats.window_days} days of decisions and outcomes and produce 3–5 short lessons — each one concrete, testable, and actionable on future days. Prefer specific patterns ("SELL calls on crypto after RSI>70 have been early") over generic advice ("be careful"). If prior lessons are still valid, restate them; drop any that the data now contradicts.`;

  const prior = ctx.lessons.length
    ? `Prior lessons (may be kept, revised, or dropped):\n${ctx.lessons.map((l, i) => `${i + 1}. ${l}`).join("\n")}`
    : "No prior lessons yet.";

  const user = `Date: ${asOf}
Rolling stats: ${JSON.stringify(ctx.stats)}

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
    if (lessons.length === 0) return { updated: false, reason: "empty output" };

    await supabaseAdmin.from("portfolio_lessons").insert({
      portfolio_id: portfolioId,
      as_of: asOf,
      lessons,
      stats: ctx.stats as unknown as never,
      window_days: ctx.stats.window_days,
    });
    return { updated: true };
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      return { updated: false, reason: "parse error" };
    }
    throw error;
  }
}
