// Explainability feed for the policy-maker nudge.
//
// Takes the most recent decision run for a portfolio and, for every order the
// AI proposed, re-derives the policy nudge that fed into that symbol's news
// score — remark by remark, with the decay factor that discounted each one.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  describePolicyNudge,
  explainPolicyNudge,
  POLICY_MAX_NUDGE,
  type PolicyNudgeExplain,
  type PolicyRow,
} from "@/lib/policy-makers";
import { policyNudgeScaleForSign, type RegimeRead } from "@/lib/policy-regime-scaling";

export type PolicyOrderExplain = {
  symbol: string;
  side: string;
  quantity: number | null;
  value: number | null;
  percent: number | null;
  conviction: number | null;
  rejected: string | null;
  reason: string | null;
  /** Final blended news score the engine used for this symbol, if recorded. */
  news_score: number | null;
  explain: PolicyNudgeExplain;
  summary: string;
};

export type PolicyDecisionExplain = {
  portfolio_id: string;
  run_date: string | null;
  decided_at: string | null;
  max_nudge: number;
  half_life_hours: number;
  /** Market regime the run detected, and the multiplier it applied. */
  regime: { posture: string; vol: string; scale: number; reason: string } | null;
  orders: PolicyOrderExplain[];
  /** True when the run had orders but no tracked remark touched any of them. */
  no_policy_input: boolean;
};

export const getPolicyDecisionExplain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ portfolioId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }): Promise<PolicyDecisionExplain> => {
    const { supabase, userId } = context;
    const num = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const p = await supabase
      .from("portfolios")
      .select("id, user_id")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (p.error || !p.data || p.data.user_id !== userId) throw new Error("Portfolio not found");

    const { data: decision } = await supabase
      .from("decisions")
      .select("run_date, created_at, raw")
      .eq("portfolio_id", data.portfolioId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const raw = (decision?.raw ?? {}) as {
      orders?: Array<Record<string, unknown>>;
      executed?: Array<Record<string, unknown>>;
      signals?: Array<Record<string, unknown>>;
      policy_regime?: { posture?: string; vol?: string; scale?: number; reason?: string } | null;
    };
    // The engine scales the policy nudge by the market regime it detected on
    // the run; replay that same multiplier so the panel's arithmetic matches.
    const policyRegime = raw.policy_regime ?? null;
    const regimeScale =
      policyRegime && Number.isFinite(Number(policyRegime.scale)) ? Number(policyRegime.scale) : 1;
    // `orders` is what the engine proposed; `executed` is what actually happened
    // (and is the only place a rejection reason is recorded). Overlay them so the
    // panel explains the real outcome, not the intent.
    const proposed = Array.isArray(raw.orders) ? raw.orders : [];
    const executed = Array.isArray(raw.executed) ? raw.executed : [];
    const key = (o: Record<string, unknown>) =>
      `${String(o.symbol ?? "").toUpperCase()}|${String(o.side ?? "").toLowerCase()}`;
    const proposedByKey = new Map(proposed.map((o) => [key(o), o]));
    const orders = executed.length
      ? executed.map((e) => ({ ...(proposedByKey.get(key(e)) ?? {}), ...e }))
      : proposed;
    const signals = Array.isArray(raw.signals) ? raw.signals : [];
    const newsScoreBySymbol = new Map<string, number | null>(
      signals.map((s) => [String(s.symbol ?? "").toUpperCase(), num(s.news_score)]),
    );

    const runDate = (decision?.run_date as string | null) ?? null;
    const asOf = runDate ?? new Date().toISOString().slice(0, 10);
    const since = new Date(new Date(`${asOf}T12:00:00Z`).getTime() - 8 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    // Same window the engine reads: a week of headlines, freshest first.
    const { data: newsRows } = await supabase
      .from("news_cache")
      .select("news_date, source, headline, url, summary, sentiment")
      .gte("news_date", since)
      .lte("news_date", asOf)
      .order("news_date", { ascending: false })
      .limit(600);

    const rows: PolicyRow[] = (newsRows ?? []).map((r) => ({
      headline: (r.headline as string) ?? "",
      summary: (r.summary as string | null) ?? null,
      source: (r.source as string | null) ?? null,
      url: (r.url as string | null) ?? null,
      date: (r.news_date as string) ?? null,
      sentiment: r.sentiment == null ? null : Number(r.sentiment),
    }));

    const explained: PolicyOrderExplain[] = orders.map((o) => {
      const symbol = String(o.symbol ?? "").toUpperCase();
      const side = String(o.side ?? "");
      const probe = explainPolicyNudge(symbol, rows, asOf);
      const explain =
        probe.nudge === 0
          ? probe
          : explainPolicyNudge(symbol, rows, asOf, {
              regimeScale: policyRegime
                ? policyNudgeScaleForSign(
                    {
                      posture: (policyRegime.posture as RegimeRead["posture"]) ?? "neutral",
                      vol: (policyRegime.vol as RegimeRead["vol"]) ?? "normal",
                      scale: regimeScale,
                      confidence: 0,
                      reason: policyRegime.reason ?? "",
                    },
                    Math.sign(probe.nudge),
                  )
                : regimeScale,
            });
      return {
        symbol,
        side,
        quantity: num(o.quantity),
        value: num(o.value),
        percent: num(o.percent),
        conviction: num(o.conviction),
        rejected: (o.rejected as string | null) ?? null,
        reason: (o.reason as string | null) ?? null,
        news_score: newsScoreBySymbol.get(symbol) ?? null,
        explain,
        summary: describePolicyNudge(explain, side),
      };
    });

    // Symbols the policy signal actually touched come first.
    explained.sort(
      (a, b) => Math.abs(b.explain.nudge) - Math.abs(a.explain.nudge) || a.symbol.localeCompare(b.symbol),
    );

    return {
      portfolio_id: data.portfolioId,
      run_date: runDate,
      decided_at: (decision?.created_at as string | null) ?? null,
      max_nudge: POLICY_MAX_NUDGE,
      half_life_hours: 48,
      regime: policyRegime
        ? {
            posture: String(policyRegime.posture ?? "neutral"),
            vol: String(policyRegime.vol ?? "normal"),
            scale: regimeScale,
            reason: String(policyRegime.reason ?? ""),
          }
        : null,
      orders: explained,
      no_policy_input: explained.length > 0 && explained.every((o) => o.explain.statements === 0),
    };
  });
