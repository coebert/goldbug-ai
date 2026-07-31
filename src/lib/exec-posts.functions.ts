import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  computeExecPostSignals,
  detectExecutivePosts,
  TRACKED_EXECUTIVES,
  type ExecPostSignal,
} from "@/lib/exec-posts";

export type ExecPostFeedItem = {
  headline: string;
  source: string | null;
  url: string | null;
  date: string | null;
  sentiment: number | null;
  executive_name: string;
  handle: string;
  org: string;
  symbols: string[];
};

export type ExecPostTracker = {
  as_of: string;
  tracked: Array<{ name: string; handle: string; org: string; symbols: string[] }>;
  posts: ExecPostFeedItem[];
  signals: ExecPostSignal[];
};

export const getExecPostTracker = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { sinceDays?: number } | undefined) => ({
    sinceDays: Math.max(1, Math.min(30, Math.round(Number(input?.sinceDays ?? 7)))),
  }))
  .handler(async ({ context, data }): Promise<ExecPostTracker> => {
    const now = new Date();
    const since = new Date(now.getTime() - data.sinceDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const { data: rows } = await context.supabase
      .from("news_cache")
      .select("news_date, source, headline, url, summary, sentiment")
      .gte("news_date", since)
      .order("news_date", { ascending: false })
      .limit(500);

    const mapped = (rows ?? []).map((r) => ({
      headline: (r.headline as string) ?? "",
      source: (r.source as string | null) ?? null,
      url: (r.url as string | null) ?? null,
      summary: (r.summary as string | null) ?? null,
      date: (r.news_date as string) ?? null,
      sentiment: r.sentiment == null ? null : Number(r.sentiment),
    }));

    const detected = detectExecutivePosts(mapped);
    const asOf = now.toISOString().slice(0, 10);

    return {
      as_of: asOf,
      tracked: TRACKED_EXECUTIVES.map((e) => ({
        name: e.name,
        handle: e.handle,
        org: e.org,
        symbols: e.symbols,
      })),
      posts: detected.slice(0, 25).map((p) => ({
        headline: p.headline,
        source: p.source ?? null,
        url: p.url ?? null,
        date: p.date ?? null,
        sentiment: p.sentiment ?? null,
        executive_name: p.executive_name,
        handle: p.handle,
        org: p.org,
        symbols: p.symbols,
      })),
      signals: computeExecPostSignals(mapped, asOf),
    };
  });
