// News-reel and decision-news-breakdown server functions. Split out of
// trading.functions.ts during Phase 3; helpers live in ./news-reel.server.
// The legacy "@/lib/trading.functions" barrel re-exports these for
// backwards compatibility.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  toExcerpt,
  type NewsReelInfluence,
  type NewsReelItem,
  type DecisionBreakdownItem,
} from "./news-reel.server";
import type { NewsRefreshResult } from "./news-refresh.server";
import { sortNewsLatestFirst } from "./news-reel-sort";
import { dedupeNewsItems, normalizeHeadlineKey } from "./news-dedupe";
import { transliterationKey } from "./news-transliterate";

/**
 * Narrow shape of a `decisions` row when only the news-related jsonb sub-keys
 * are projected. Keeps the wire payload small — the full `raw` blob is orders
 * of magnitude bigger and unused by the news views.
 */
type DecisionNewsSlice = {
  id: string;
  portfolio_id: string;
  run_date: string;
  rationale: string;
  raw_news:
    | Array<{
        headline?: string;
        source?: string | null;
        url?: string | null;
        sentiment?: number | null;
        source_weight?: number | null;
      }>
    | null;
  raw_executed: Array<{ action?: string; symbol?: string; qty?: number | null }> | null;
  raw_orders: Array<{ action?: string; symbol?: string; qty?: number | null }> | null;
};

export const getGlobalNewsReel = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { sinceDays?: number; limit?: number } | undefined) => {
    const s = Math.max(1, Math.min(120, Math.round(Number(input?.sinceDays ?? 5))));
    const l = Math.max(10, Math.min(400, Math.round(Number(input?.limit ?? 40))));
    return { sinceDays: s, limit: l };
  })
  .handler(async ({ context, data }): Promise<{ items: NewsReelItem[]; as_of: string; has_more: boolean; since_days: number; limit: number }> => {
    const { sinceDays, limit } = data;
    const asOf = new Date();
    const since = new Date(asOf.getTime() - sinceDays * 86_400_000).toISOString().slice(0, 10);

    // 1. Recent global news (auth-readable cache). Fetch limit+1 to detect has_more.
    const fetchCap = Math.min(500, limit + 60);
    const readNews = async () =>
      (
        await context.supabase
          .from("news_cache")
          .select("id, news_date, fetched_at, source, headline, url, summary, original_headline, original_language, translation_confidence, relevance_score, relevance_reason, relevance_tags")
          .gte("news_date", since)
          .order("news_date", { ascending: false })
          .order("fetched_at", { ascending: false })
          .limit(fetchCap)
      ).data ?? [];
    let news = await readNews();
    if (news.length === 0) return { items: [], as_of: asOf.toISOString(), has_more: false, since_days: sinceDays, limit };

    // Opportunistic translation repair: cached non-English rows with no
    // translation yet get filled in synchronously (Workers cancel background
    // promises the moment the response returns, so `void`-style backfill did
    // nothing in production). Bounded to the dates actually shown, capped
    // to a few LLM calls per request.
    const { looksNonEnglish } = await import("@/lib/news.server");
    const needsTranslation = news.filter(
      (r) => !r.original_language && looksNonEnglish((r.headline as string) ?? ""),
    );
    if (needsTranslation.length > 0) {
      const { backfillTranslations } = await import("@/lib/news.server");
      const dates = Array.from(new Set(needsTranslation.map((r) => r.news_date as string))).slice(0, 5);
      await Promise.all(dates.map((d) => backfillTranslations(d).catch(() => null)));
      news = await readNews();
    }

    // Opportunistic relevance repair: rows cached before the ranker existed
    // (or written by a path that skipped it) get scored now, so the reel never
    // shows an unranked headline. Bounded to the dates on screen.
    const unranked = news.filter((r) => (r as { relevance_score?: number | null }).relevance_score == null);
    if (unranked.length > 0) {
      const { ensureRelevanceScored, loadRelevanceContext } = await import("@/lib/news-relevance.server");
      const dates = Array.from(new Set(unranked.map((r) => r.news_date as string))).slice(0, 3);
      try {
        const ctx = await loadRelevanceContext();
        for (const d of dates) await ensureRelevanceScored(d, { ctx, max: 60, trigger: "reel-repair" });
        news = await readNews();
      } catch (err) {
        console.warn("news reel: relevance repair failed", err instanceof Error ? err.message : String(err));
      }
    }

    // 2. Recent decisions across the user's own portfolios.
    const { data: portfolios } = await context.supabase
      .from("portfolios")
      .select("id, name, universe, risk_level");
    const pMap = new Map(
      (portfolios ?? []).map((p) => [
        p.id,
        {
          name: p.name,
          universe: (Array.isArray(p.universe) ? p.universe : []) as string[],
          risk_level: (p.risk_level ?? "balanced") as string,
        },
      ]),
    );
    const { data: decisions } = await context.supabase
      .from("decisions")
      // Project only the jsonb sub-keys this view reads. The full `raw` payload
      // is large enough to dominate the response, and none of it is used here.
      .select(
        "id, portfolio_id, run_date, rationale, raw_news:raw->news, raw_executed:raw->executed, raw_orders:raw->orders",
      )
      .gte("run_date", since)
      .order("run_date", { ascending: false })
      .limit(120)
      .overrideTypes<DecisionNewsSlice[]>();

    // 3. Build headline -> influences lookup.
    const infl = new Map<
      string,
      {
        sum: number;
        n: number;
        rows: NewsReelInfluence[];
        assetClasses: Set<string>;
        riskLevels: Set<string>;
        symbols: Set<string>;
      }
    >();
    // Secondary index on the folded romanised key (transliteration-tolerant).
    const inflTranslit = new Map<string, ReturnType<typeof infl.get> extends undefined ? never : NonNullable<ReturnType<typeof infl.get>>>();
    for (const d of decisions ?? []) {
      const p = pMap.get(d.portfolio_id);
      const name = p?.name ?? "Portfolio";
      const raw = {
        news: d.raw_news ?? [],
        executed: d.raw_executed ?? [],
        orders: d.raw_orders ?? [],
      };
      const usedNews = raw.news ?? [];
      if (usedNews.length === 0) continue;
      const acts = (raw.executed && raw.executed.length > 0 ? raw.executed : raw.orders) ?? [];
      const trimmed = acts
        .filter((a) => a && a.action && a.symbol && a.action !== "HOLD")
        .slice(0, 4)
        .map((a) => ({ action: String(a.action), symbol: String(a.symbol), qty: a.qty ?? null }));

      // Pre-compute per-decision impact = |sentiment| * source_weight, and total for normalization.
      const impacts = usedNews.map((n) => {
        const s = typeof n.sentiment === "number" ? Math.abs(n.sentiment) : 0;
        const w = typeof n.source_weight === "number" ? Math.max(0, n.source_weight) : 0.4;
        return s * w;
      });
      const impactTotal = impacts.reduce((a, b) => a + b, 0);

      for (let i = 0; i < usedNews.length; i++) {
        const n = usedNews[i];
        const head = normalizeHeadlineKey(n.headline);
        if (!head) continue;
        const bucket = infl.get(head) ?? {

          sum: 0, n: 0, rows: [],
          assetClasses: new Set<string>(), riskLevels: new Set<string>(), symbols: new Set<string>(),
        };
        if (typeof n.sentiment === "number") { bucket.sum += n.sentiment; bucket.n += 1; }
        const impact = impacts[i];
        const impactPct = impactTotal > 0 ? (impact / impactTotal) * 100 : null;
        bucket.rows.push({
          decision_id: d.id,
          portfolio_id: d.portfolio_id,
          portfolio_name: name,
          run_date: d.run_date,
          sentiment: typeof n.sentiment === "number" ? n.sentiment : null,
          source_weight: typeof n.source_weight === "number" ? n.source_weight : null,
          impact: Number.isFinite(impact) ? Number(impact.toFixed(3)) : null,
          impact_pct: impactPct != null ? Number(impactPct.toFixed(1)) : null,
          rationale: (d.rationale ?? null) as string | null,
          actions: trimmed,
        });
        if (p) {
          for (const c of p.universe) bucket.assetClasses.add(c);
          bucket.riskLevels.add(p.risk_level);
        }
        for (const a of trimmed) bucket.symbols.add(a.symbol);
        infl.set(head, bucket);
        // Same bucket under the folded romanised key, so a citation logged in
        // Cyrillic still resolves against a romanised reel row (and vice versa).
        const tKey = transliterationKey(n.headline, normalizeHeadlineKey);
        if (tKey) inflTranslit.set(tKey, bucket);

      }
    }

    // 4. Assemble reel items with a plain-English note per headline.
    //    Citations are matched on the NORMALISED key of both the (possibly
    //    translated) headline and the original-language headline, so a story
    //    the AI cited before a translation backfill — or cited in its source
    //    language — still shows its decision links after the row flips to
    //    English.
    const items: NewsReelItem[] = news.map((r) => {
      const original = (r as { original_headline?: string | null }).original_headline ?? null;
      const bucket =
        infl.get(normalizeHeadlineKey(r.headline)) ??
        (original ? infl.get(normalizeHeadlineKey(original)) : undefined) ??
        inflTranslit.get(transliterationKey(r.headline, normalizeHeadlineKey)) ??
        (original
          ? inflTranslit.get(transliterationKey(original, normalizeHeadlineKey))
          : undefined);
      const rows = bucket?.rows ?? [];

      const avg = bucket && bucket.n > 0 ? bucket.sum / bucket.n : null;
      let note: string;
      if (rows.length === 0) {
        note = "Logged in the AI's briefing pool; no active decision has cited it yet.";
      } else {
        const tone = avg == null ? "neutral" : avg > 0.15 ? "bullish" : avg < -0.15 ? "bearish" : "neutral";
        const acts = rows.flatMap((x) => x.actions);
        const actSummary = acts.length === 0
          ? "reinforced a HOLD across affected positions"
          : Array.from(new Set(acts.map((a) => `${a.action} ${a.symbol}`))).slice(0, 3).join(", ");
        const portfolioNames = Array.from(new Set(rows.map((r) => r.portfolio_name))).slice(0, 3).join(", ");
        note = `Scored ${tone}${avg != null ? ` (${avg >= 0 ? "+" : ""}${avg.toFixed(2)})` : ""} and fed into ${rows.length} decision${rows.length === 1 ? "" : "s"} on ${portfolioNames} — ${actSummary}.`;
      }
      return {
        id: r.id,
        date: r.news_date,
        fetched_at: ((r as { fetched_at?: string | null }).fetched_at ?? null),
        source: r.source,
        headline: r.headline,
        url: r.url,
        original_headline: (r as { original_headline?: string | null }).original_headline ?? null,
        original_language: (r as { original_language?: string | null }).original_language ?? null,
        translation_confidence: (() => {
          const c = (r as { translation_confidence?: number | string | null }).translation_confidence;
          return c == null ? null : Number(c);
        })(),

        relevance_score: (() => {
          const v = (r as { relevance_score?: number | string | null }).relevance_score;
          return v == null ? null : Number(v);
        })(),
        relevance_reason: ((r as { relevance_reason?: string | null }).relevance_reason ?? null),
        relevance_tags: (() => {
          const t = (r as { relevance_tags?: unknown }).relevance_tags;
          return Array.isArray(t) ? (t as unknown[]).map((x) => String(x)) : [];
        })(),

        avg_sentiment: avg,
        decisions_count: rows.length,
        influences: rows.slice(0, 6),
        note,
        excerpt: toExcerpt((r as { summary?: string | null }).summary),
        asset_classes: bucket ? Array.from(bucket.assetClasses).sort() : [],
        risk_levels: bucket ? Array.from(bucket.riskLevels).sort() : [],
        symbols: bucket ? Array.from(bucket.symbols).sort() : [],
      };
    });

    // Sort: strictly newest first (shared helper, also used by the reel UI),
    // then drop repeats of the same story (same canonical URL or headline)
    // that earlier cron runs cached under a different date/source. Sorting
    // first means the surviving copy is always the freshest one.
    const sorted = sortNewsLatestFirst(items);
    const deduped = dedupeNewsItems(sorted);

    const sliced = deduped.slice(0, limit);
    return { items: sliced, as_of: asOf.toISOString(), has_more: deduped.length > limit, since_days: sinceDays, limit };
  });

export const getDecisionNewsBreakdown = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ items: DecisionBreakdownItem[]; as_of: string }> => {
    const asOf = new Date();
    const since = new Date(asOf.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);

    const { data: portfolios } = await context.supabase
      .from("portfolios")
      .select("id, name");
    const pMap = new Map((portfolios ?? []).map((p) => [p.id, p.name]));

    const { data: decisions } = await context.supabase
      .from("decisions")
      .select(
        "id, portfolio_id, run_date, rationale, raw_news:raw->news, raw_executed:raw->executed, raw_orders:raw->orders",
      )
      .gte("run_date", since)
      .order("run_date", { ascending: false })
      .limit(30)
      .overrideTypes<DecisionNewsSlice[]>();

    const items: DecisionBreakdownItem[] = (decisions ?? []).map((d) => {
      const raw = {
        news: d.raw_news ?? [],
        executed: d.raw_executed ?? [],
        orders: d.raw_orders ?? [],
      };
      const news = (raw.news ?? []).filter((n) => (n.headline ?? "").trim().length > 0);
      const ranked = [...news].sort((a, b) => {
        const av = typeof a.sentiment === "number" ? Math.abs(a.sentiment) : -1;
        const bv = typeof b.sentiment === "number" ? Math.abs(b.sentiment) : -1;
        return bv - av;
      });
      const top = ranked.slice(0, 5).map((n) => ({
        headline: String(n.headline),
        source: n.source ?? null,
        url: n.url ?? null,
        sentiment: typeof n.sentiment === "number" ? n.sentiment : null,
      }));
      const acts = (raw.executed && raw.executed.length > 0 ? raw.executed : raw.orders) ?? [];
      const actions = acts
        .filter((a) => a && a.action && a.symbol)
        .slice(0, 8)
        .map((a) => ({ action: String(a.action), symbol: String(a.symbol), qty: a.qty ?? null }));
      return {
        decision_id: d.id,
        portfolio_id: d.portfolio_id,
        portfolio_name: pMap.get(d.portfolio_id) ?? "Portfolio",
        run_date: d.run_date,
        rationale: d.rationale ?? null,
        actions,
        top_news: top,
        total_news_considered: news.length,
      };
    });

    // Older saved runs recorded the headline but not its link, so those cited
    // headlines rendered as dead text. Resolve the real article URL from the
    // news cache by headline so every cited story opens its source.
    const missing = Array.from(
      new Set(
        items.flatMap((i) => i.top_news.filter((n) => !n.url).map((n) => n.headline)),
      ),
    ).slice(0, 300);
    if (missing.length > 0) {
      const found = new Map<string, { url: string | null; source: string | null }>();
      for (let i = 0; i < missing.length; i += 60) {
        const chunk = missing.slice(i, i + 60);
        const { data } = await context.supabase
          .from("news_cache")
          .select("headline, url, source")
          .in("headline", chunk)
          .not("url", "is", null)
          .limit(chunk.length * 3);
        for (const r of data ?? []) {
          if (!found.has(r.headline as string)) {
            found.set(r.headline as string, {
              url: (r.url as string | null) ?? null,
              source: (r.source as string | null) ?? null,
            });
          }
        }
      }
      for (const item of items) {
        item.top_news = item.top_news.map((n) => {
          if (n.url) return n;
          const hit = found.get(n.headline);
          return hit ? { ...n, url: hit.url, source: n.source ?? hit.source } : n;
        });
      }
    }

    return { items, as_of: asOf.toISOString() };
  });

// On-demand cache refresh used by the reel's "Refresh now" button. The cron
// hook only runs against the published deployment, so without this the reel
// could only ever re-read a stale cache.
export const refreshGlobalNews = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { max?: number } | undefined) => ({
    max: Math.max(10, Math.min(80, Math.round(Number(input?.max ?? 30)))),
  }))
  .handler(async ({ data }): Promise<NewsRefreshResult> => {
    const { refreshGlobalNewsNow } = await import("./news-refresh.server");
    return refreshGlobalNewsNow(data.max);
  });
