import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  computeCurrencyStances,
  computePolicySignals,
  detectPolicyStatements,
  TRACKED_POLICY_MAKERS,
  type PolicyCurrencyStance,
  type PolicySignal,
} from "@/lib/policy-makers";

export type PolicyStatementItem = {
  headline: string;
  source: string | null;
  url: string | null;
  date: string | null;
  maker_name: string;
  role: string;
  org: string;
  ccy: string;
  stance: string;
  tone: number;
  symbols: string[];
};

export type PolicyTracker = {
  as_of: string;
  tracked: Array<{ name: string; role: string; org: string; ccy: string; symbols: string[] }>;
  statements: PolicyStatementItem[];
  signals: PolicySignal[];
  currencies: PolicyCurrencyStance[];
};

export const getPolicyTracker = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { sinceDays?: number } | undefined) => ({
    sinceDays: Math.max(1, Math.min(30, Math.round(Number(input?.sinceDays ?? 7)))),
  }))
  .handler(async ({ context, data }): Promise<PolicyTracker> => {
    const now = new Date();
    const since = new Date(now.getTime() - data.sinceDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const { data: rows } = await context.supabase
      .from("news_cache")
      .select("news_date, source, headline, url, summary, sentiment")
      .gte("news_date", since)
      .order("news_date", { ascending: false })
      .limit(600);

    const mapped = (rows ?? []).map((r) => ({
      headline: (r.headline as string) ?? "",
      source: (r.source as string | null) ?? null,
      url: (r.url as string | null) ?? null,
      summary: (r.summary as string | null) ?? null,
      date: (r.news_date as string) ?? null,
      sentiment: r.sentiment == null ? null : Number(r.sentiment),
    }));

    const asOf = now.toISOString().slice(0, 10);
    const detected = detectPolicyStatements(mapped);

    return {
      as_of: asOf,
      tracked: TRACKED_POLICY_MAKERS.map((m) => ({
        name: m.name,
        role: m.role,
        org: m.org,
        ccy: m.ccy,
        symbols: m.symbols,
      })),
      statements: detected.slice(0, 25).map((s) => ({
        headline: s.headline,
        source: s.source ?? null,
        url: s.url ?? null,
        date: s.date ?? null,
        maker_name: s.maker_name,
        role: s.role,
        org: s.org,
        ccy: s.ccy,
        stance: s.stance,
        tone: s.tone,
        symbols: s.symbols,
      })),
      signals: computePolicySignals(mapped, asOf),
      currencies: computeCurrencyStances(mapped, asOf),
    };
  });
