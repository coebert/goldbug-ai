// Batch backtest → lesson extractor.
//
// Runs the long-horizon rule-based backtester across a matrix of strategy
// configurations (risk_level × rebalance × topK) over the last 5 years,
// slices the results per historical regime window, then asks the LLM to
// distil concrete, testable lessons per RUNTIME regime label (bull_quiet,
// bull_volatile, correction, bear, crisis, recovery) and one general bucket.
//
// The resulting lesson rows are inserted into public.portfolio_lessons with
// portfolio_id = NULL and user_id = caller, so they flow into every one of
// the user's portfolios through fetchLatestLessons() (which already filters
// on user_id + regime).

import { generateText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  runLongHorizonBacktest,
  LONG_HORIZON_UNIVERSE,
  REGIMES,
  type Metrics,
} from "./long-horizon.server";
import type { Database } from "@/integrations/supabase/types";
import type { RegimeLabel } from "./regime-detector.server";

type RiskLevel = Database["public"]["Enums"]["risk_level"];
type ConfigKey = { rl: RiskLevel; rb: "monthly" | "quarterly"; k: number };

// Map historical playbook regime "kind" onto the runtime regime labels the
// live engine actually assigns each day.
function runtimeLabelsFor(kind: (typeof REGIMES)[number]["kind"]): RegimeLabel[] {
  switch (kind) {
    case "bull":
      return ["bull_quiet", "bull_volatile"];
    case "bear":
      return ["bear"];
    case "shock":
      return ["crisis"];
    case "recovery":
      return ["recovery"];
    case "sideways":
      return ["correction"];
  }
}

type ConfigRun = {
  config: ConfigKey;
  aegis: Metrics;
  spy: Metrics;
  sixtyForty: Metrics | null;
  perRegime: Array<{
    key: string;
    name: string;
    kind: (typeof REGIMES)[number]["kind"];
    aegis: Metrics;
    spy: Metrics;
  }>;
  tradeCount: number;
  totalCostsPaid: number;
};

const LessonsSchema = z.object({ lessons: z.array(z.string()) });

function fmtCfg(c: ConfigKey): string {
  return `${c.rl}/${c.rb}/top${c.k}`;
}

function fmtMetrics(m: Metrics): string {
  return `CAGR ${m.cagrPct.toFixed(1)}% · DD ${m.maxDrawdownPct.toFixed(1)}% · Sharpe ${m.sharpe.toFixed(2)} · Vol ${m.volatilityPct.toFixed(1)}%`;
}

export type BatchLessonsResult = {
  from: string;
  to: string;
  configs_run: number;
  lessons_written: number;
  regimes_covered: string[];
  duration_ms: number;
  per_config_summary: Array<{
    config: string;
    cagr_pct: number;
    dd_pct: number;
    sharpe: number;
    vs_spy_pct: number;
    trades: number;
  }>;
};

export async function runBatchBacktestAndLearn(
  userId: string,
): Promise<BatchLessonsResult> {
  const started = Date.now();
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const from = new Date(today.getTime() - 5 * 365 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const risks: RiskLevel[] = ["conservative", "balanced", "aggressive"];
  const rebals: Array<"monthly" | "quarterly"> = ["monthly", "quarterly"];
  const topKs = [4, 6, 8];

  const combos: ConfigKey[] = [];
  for (const rl of risks) for (const rb of rebals) for (const k of topKs) combos.push({ rl, rb, k });

  const runs: ConfigRun[] = [];

  // Run configurations sequentially to avoid overwhelming the price cache /
  // rate limits — each backtest is CPU-bound but tiny (~1250 daily bars × 15
  // symbols) and reuses cached Yahoo closes.
  for (const cfg of combos) {
    try {
      const r = await runLongHorizonBacktest({
        from,
        to,
        startingCash: 1000,
        currency: "GBP",
        riskLevel: cfg.rl,
        riskConfig: null,
        universe: LONG_HORIZON_UNIVERSE,
        rebalance: cfg.rb,
        topK: cfg.k,
      });
      const aegis = r.series.find((s) => s.key === "aegis");
      const spy = r.series.find((s) => s.key === "spy");
      const sixtyForty = r.series.find((s) => s.key === "6040");
      if (!aegis || !spy) continue;

      const perRegime = r.regimes
        .map((reg) => {
          const a = reg.rows.find((x) => x.seriesKey === "aegis");
          const b = reg.rows.find((x) => x.seriesKey === "spy");
          if (!a || !b) return null;
          return {
            key: reg.key,
            name: reg.name,
            kind: reg.kind as (typeof REGIMES)[number]["kind"],
            aegis: a.metrics,
            spy: b.metrics,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x != null);

      runs.push({
        config: cfg,
        aegis: aegis.metrics,
        spy: spy.metrics,
        sixtyForty: sixtyForty?.metrics ?? null,
        perRegime,
        tradeCount: r.tradeCount,
        totalCostsPaid: r.totalCostsPaid,
      });
    } catch (e) {
      // Skip failed combos rather than abort the whole batch.
      console.warn("[batch-lessons] combo failed", fmtCfg(cfg), e);
    }
  }

  if (runs.length === 0) {
    return {
      from,
      to,
      configs_run: 0,
      lessons_written: 0,
      regimes_covered: [],
      duration_ms: Date.now() - started,
      per_config_summary: [],
    };
  }

  // Bucket per RUNTIME regime label (many-to-many with historical regimes).
  const byLabel = new Map<
    RegimeLabel | "general",
    Array<{ config: ConfigKey; regimeKey: string; regimeName: string; aegis: Metrics; spy: Metrics }>
  >();
  for (const run of runs) {
    for (const reg of run.perRegime) {
      for (const label of runtimeLabelsFor(reg.kind)) {
        if (!byLabel.has(label)) byLabel.set(label, []);
        byLabel.get(label)!.push({
          config: run.config,
          regimeKey: reg.key,
          regimeName: reg.name,
          aegis: reg.aegis,
          spy: reg.spy,
        });
      }
    }
  }

  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing — cannot generate lessons");
  const gateway = createLovableAiGatewayProvider(key);
  const model = gateway("google/gemini-3.6-flash");

  let written = 0;
  const covered: string[] = [];

  // Per-regime lesson buckets.
  for (const [label, rows] of byLabel.entries()) {
    if (label === "general" || rows.length < 3) continue;
    // Cap the evidence table to keep prompts small.
    const table = rows
      .slice(0, 60)
      .map(
        (r) =>
          `${fmtCfg(r.config)} in "${r.regimeName}" (${r.regimeKey}): Aegis ${fmtMetrics(r.aegis)} vs SPY ${fmtMetrics(r.spy)}`,
      )
      .join("\n");

    const system = `You are the portfolio's evidence-based research analyst. Distil concrete, testable trading lessons that will be applied automatically by the AI decision engine whenever the current market regime is labelled "${label}". Base every lesson strictly on the backtest evidence provided — do not invent numbers.`;

    const prompt = `Regime label: "${label}"
Historical windows aggregated into this label: ${Array.from(new Set(rows.map((r) => r.regimeName))).join("; ")}
Configurations tested: ${runs.length} (risk × rebalance × concentration)
Rows below compare the Aegis rule-based strategy against SPY buy-and-hold in the same regime window.

${table}

Produce 4-7 lessons. Each lesson must:
- Reference a concrete pattern from the numbers (e.g. "quarterly rebalancing with top-4 concentration beat monthly by +X% CAGR in bear windows")
- Be actionable at the next daily decision (position sizing, rebalance cadence, risk tier, cash floor, stop policy, or concentration)
- Fit under 180 characters, plain English
Return { "lessons": string[] }.`;

    try {
      const { output } = await generateText({
        model,
        system,
        prompt,
        output: Output.object({ schema: LessonsSchema }),
      });
      const lessons = (output.lessons ?? [])
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(0, 7);
      if (lessons.length === 0) continue;

      await supabaseAdmin.from("portfolio_lessons").insert({
        user_id: userId,
        portfolio_id: null,
        as_of: to,
        lessons,
        stats: {
          source: "batch_backtest_v1",
          window_years: 5,
          configs_evaluated: runs.length,
          rows_in_bucket: rows.length,
          historical_regimes: Array.from(new Set(rows.map((r) => r.regimeKey))),
        } as unknown as never,
        window_days: Math.round(5 * 365),
        regime: label,
      });
      written++;
      covered.push(label);
    } catch (e) {
      if (NoObjectGeneratedError.isInstance(e)) continue;
      console.warn("[batch-lessons] regime bucket failed", label, e);
    }
  }

  // General bucket — cross-config evidence over the full 5-year window.
  const generalTable = runs
    .map(
      (r) =>
        `${fmtCfg(r.config)}: Aegis ${fmtMetrics(r.aegis)} vs SPY ${fmtMetrics(r.spy)} · ${r.tradeCount} trades · costs paid £${r.totalCostsPaid.toFixed(0)}`,
    )
    .join("\n");
  try {
    const { output } = await generateText({
      model,
      system:
        "You are the portfolio's evidence-based research analyst. Distil general-purpose trading lessons the AI will apply whenever no regime-specific lesson matches. Base every lesson strictly on the 5-year backtest matrix below.",
      prompt: `Full 5-year backtest results across ${runs.length} configurations vs SPY buy-and-hold:
${generalTable}

Produce 6-10 lessons. Each must reference a concrete pattern (which risk tier, cadence, or concentration produced the best risk-adjusted returns) and be actionable at the next daily decision. Under 180 characters each.
Return { "lessons": string[] }.`,
      output: Output.object({ schema: LessonsSchema }),
    });
    const lessons = (output.lessons ?? [])
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(0, 10);
    if (lessons.length) {
      await supabaseAdmin.from("portfolio_lessons").insert({
        user_id: userId,
        portfolio_id: null,
        as_of: to,
        lessons,
        stats: {
          source: "batch_backtest_v1",
          window_years: 5,
          configs_evaluated: runs.length,
          scope: "general_5y",
        } as unknown as never,
        window_days: Math.round(5 * 365),
        regime: null,
      });
      written++;
      covered.push("general");
    }
  } catch (e) {
    if (!NoObjectGeneratedError.isInstance(e)) {
      console.warn("[batch-lessons] general bucket failed", e);
    }
  }

  const per_config_summary = runs.map((r) => ({
    config: fmtCfg(r.config),
    cagr_pct: Number(r.aegis.cagrPct.toFixed(2)),
    dd_pct: Number(r.aegis.maxDrawdownPct.toFixed(2)),
    sharpe: Number(r.aegis.sharpe.toFixed(2)),
    vs_spy_pct: Number((r.aegis.cagrPct - r.spy.cagrPct).toFixed(2)),
    trades: r.tradeCount,
  }));

  return {
    from,
    to,
    configs_run: runs.length,
    lessons_written: written,
    regimes_covered: covered,
    duration_ms: Date.now() - started,
    per_config_summary,
  };
}
