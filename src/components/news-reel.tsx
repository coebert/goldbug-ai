import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { citationHref, newsSearchUrl } from "@/lib/news-citation";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { getGlobalNewsReel, refreshGlobalNews } from "@/lib/trading.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TranslationBadge } from "@/components/translation-badge";
import { Link } from "@tanstack/react-router";
import { formatUkDate, formatUkDateTime, formatUkTime, ukZoneAbbr } from "@/lib/uk-time";
import { sortNewsLatestFirst } from "@/lib/news-reel-sort";
import { relevanceBand, relevanceBandLabel, sortByRelevance } from "@/lib/news-relevance";
import { dedupeNewsItems } from "@/lib/news-dedupe";
import { NewsBackfillControls } from "@/components/news-backfill-controls";
import { NewsRelevanceTelemetryCard } from "@/components/news-relevance-telemetry-card";

/** Badge colour per relevance band — semantic tokens only. */
function relevanceCls(score: number): string {
  switch (relevanceBand(score)) {
    case "critical":
      return "bg-primary/15 text-primary";
    case "high":
      return "bg-primary/10 text-primary";
    case "moderate":
      return "bg-muted text-foreground";
    default:
      return "bg-muted/60 text-muted-foreground";
  }
}
import { NEWS_TOPICS, classifyNewsTopic } from "@/lib/news-topics";


import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChevronDown, ChevronRight, ExternalLink, Info, Newspaper, Pause, Play, RefreshCw, Sparkles, Target } from "lucide-react";
import { publishRationaleRefresh } from "@/lib/rationale-refresh";

// Absolute sentiment threshold treated as a "strong" market-moving signal.
const STRONG_SENTIMENT_THRESHOLD = 0.4;
// How long a newly-arrived headline stays visually highlighted.
const HIGHLIGHT_DURATION_MS = 45_000;

function sentimentTone(v: number | null) {
  if (v == null) return { label: "unscored", cls: "text-muted-foreground bg-muted" };
  if (v > 0.15) return { label: `bullish +${v.toFixed(2)}`, cls: "text-primary bg-primary/10" };
  if (v < -0.15) return { label: `bearish ${v.toFixed(2)}`, cls: "text-destructive bg-destructive/10" };
  return { label: `neutral ${v >= 0 ? "+" : ""}${v.toFixed(2)}`, cls: "text-foreground bg-muted" };
}

// Reliability tiers by source. Higher = more editorially rigorous / less prone to rumor.
const SOURCE_TIERS: Array<{ tier: "high" | "medium" | "low"; score: number; match: RegExp }> = [
  { tier: "high", score: 95, match: /reuters|associated press|\bap\b|bloomberg|financial times|wall street journal|wsj|the economist|bbc|npr|nikkei|dow jones/i },
  { tier: "high", score: 88, match: /new york times|nyt|washington post|guardian|le monde|der spiegel|abc news|cbs news|nbc news|cnbc|marketwatch|barron/i },
  { tier: "medium", score: 72, match: /forbes|business insider|fortune|axios|politico|the hill|time\.com|newsweek|usa today|yahoo finance|investing\.com|seeking alpha/i },
  { tier: "medium", score: 62, match: /coindesk|cointelegraph|the block|decrypt|techcrunch|the verge|wired|engadget/i },
  { tier: "low", score: 45, match: /reddit|medium\.com|substack|blogspot|wordpress|prnewswire|globenewswire|businesswire|press release/i },
];

function credibilityFor(source: string | null | undefined) {
  if (!source) return { tier: "unknown" as const, score: 50, label: "Credibility n/a", cls: "text-muted-foreground bg-muted" };
  const hit = SOURCE_TIERS.find((t) => t.match.test(source));
  if (!hit) return { tier: "medium" as const, score: 60, label: "Credibility 60", cls: "text-foreground bg-muted" };
  const cls =
    hit.tier === "high" ? "text-primary bg-primary/10"
    : hit.tier === "low" ? "text-destructive bg-destructive/10"
    : "text-foreground bg-muted";
  return { tier: hit.tier, score: hit.score, label: `Credibility ${hit.score}`, cls };
}

/** Deep-link to the AI report for the run that reacted to a headline. */
function RunReportLink({ runDate, className = "" }: { runDate: string; className?: string }) {
  return (
    <Link
      to="/daily-report"
      search={{ date: runDate }}
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-0.5 font-medium text-primary hover:underline ${className}`}
      title={`Open the AI report for ${runDate}`}
    >
      Report
      <ExternalLink className="h-2.5 w-2.5" />
    </Link>
  );
}

/** "BUY NVDA ×4, SELL VWRL" — the holdings a run actually adjusted. */
function adjustedSummary(actions: Array<{ action: string; symbol: string; qty?: number | null }>): string {
  if (actions.length === 0) return "no holdings adjusted";
  return actions
    .slice(0, 4)
    .map((a) => `${a.action.toUpperCase()} ${a.symbol}${a.qty != null ? ` ×${a.qty}` : ""}`)
    .join(", ");
}

function recencyFor(dateStr: string | null | undefined, now: number) {
  if (!dateStr) return { score: 0, label: "Recency n/a", ageLabel: "unknown", cls: "text-muted-foreground bg-muted" };
  const t = Date.parse(dateStr);
  if (!Number.isFinite(t)) return { score: 0, label: "Recency n/a", ageLabel: "unknown", cls: "text-muted-foreground bg-muted" };
  const hours = Math.max(0, (now - t) / 3_600_000);
  // Half-life ~ 48h; 0h => 100, 48h => 50, 96h => 25, 7d => ~9
  const score = Math.round(100 * Math.pow(0.5, hours / 48));
  const ageLabel =
    hours < 1 ? `${Math.max(1, Math.round(hours * 60))}m old`
    : hours < 48 ? `${Math.round(hours)}h old`
    : `${Math.round(hours / 24)}d old`;
  const cls =
    score >= 75 ? "text-primary bg-primary/10"
    : score >= 40 ? "text-foreground bg-muted"
    : "text-destructive bg-destructive/10";
  return { score, label: `Recency ${score}`, ageLabel, cls };
}

const ASSET_CLASSES = ["stock", "etf", "crypto", "commodity", "fx"] as const;
const RISK_LEVELS = ["conservative", "balanced", "aggressive"] as const;

const REFRESH_OPTIONS = [
  { key: "1m", label: "1 min", ms: 60_000 },
  { key: "5m", label: "5 min", ms: 5 * 60_000 },
  { key: "15m", label: "15 min", ms: 15 * 60_000 },
  { key: "1h", label: "Hourly", ms: 60 * 60_000 },
  { key: "1d", label: "Daily", ms: 24 * 60 * 60_000 },
  { key: "off", label: "Off", ms: 0 },
] as const;
type RefreshKey = typeof REFRESH_OPTIONS[number]["key"];
const REFRESH_STORAGE_KEY = "news-reel-refresh-interval";

function formatAgo(from: number | null, now: number): string {
  if (from == null) return "never";
  const s = Math.max(0, Math.floor((now - from) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function NewsReel() {
  const fetchReel = useServerFn(getGlobalNewsReel);
  const refreshSource = useServerFn(refreshGlobalNews);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState<RefreshKey>(() => {
    if (typeof window === "undefined") return "5m";
    const stored = window.localStorage.getItem(REFRESH_STORAGE_KEY) as RefreshKey | null;
    return stored && REFRESH_OPTIONS.some((o) => o.key === stored) ? stored : "5m";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(REFRESH_STORAGE_KEY, refreshKey);
    }
  }, [refreshKey]);
  const refreshMs = REFRESH_OPTIONS.find((o) => o.key === refreshKey)?.ms ?? 5 * 60_000;

  const [sinceDays, setSinceDays] = useState<number>(5);
  const [limit, setLimit] = useState<number>(40);
  const q = useQuery({
    queryKey: ["global-news-reel", sinceDays, limit],
    queryFn: () => fetchReel({ data: { sinceDays, limit } }),
    staleTime: refreshMs > 0 ? refreshMs : 5 * 60_000,
    refetchInterval: refreshMs > 0 ? refreshMs : false,
  });
  const hasMore = q.data?.has_more ?? false;
  const loadMore = () => {
    setSinceDays((d) => Math.min(120, d + 10));
    setLimit((l) => Math.min(400, l + 40));
  };
  // Infinite scroll sentinel: observed by an IntersectionObserver rooted on
  // the reel's scroll container. When it enters the viewport we auto-request
  // the next page, provided we're not already fetching and more data exists.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const isFetching = q.isFetching;
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;


  // "Now" tick so the "updated Xs ago" label stays live.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);
  const lastUpdated = q.dataUpdatedAt || null;

  // Wire the sentinel to an IntersectionObserver whose root is the reel's
  // scroll container. As soon as the sentinel is visible (near the bottom)
  // and we're not mid-fetch, expand the window. Re-runs when hasMore or
  // fetching state changes so we don't fire while a load is in-flight and
  // rebind cleanly once new data arrives.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollerRef.current;
    if (!sentinel || !root) return;
    if (!hasMore || isFetching) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            loadMoreRef.current();
            break;
          }
        }
      },
      { root, rootMargin: "160px 0px", threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hasMore, isFetching]);



  const [paused, setPaused] = useState(false);
  const [assetFilter, setAssetFilter] = useState<Set<string>>(new Set());
  const [riskFilter, setRiskFilter] = useState<Set<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState<Set<string>>(new Set());
  const [topicFilter, setTopicFilter] = useState<Set<string>>(new Set());
  const [onlyCited, setOnlyCited] = useState(false);
  const [sortMode, setSortMode] = useState<"latest" | "reliability" | "relevance">("latest");
  // Hide headlines the ranker judged unlikely to touch the user's book.
  const [onlyRelevant, setOnlyRelevant] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterCount =
    assetFilter.size + riskFilter.size + sourceFilter.size + topicFilter.size +
    (onlyCited ? 1 : 0) + (onlyRelevant ? 1 : 0) + (sortMode !== "latest" ? 1 : 0);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  // Track which headline IDs we've already seen so we can highlight & notify on genuinely new ones.
  const seenIdsRef = useRef<Set<string> | null>(null);
  const [highlightIds, setHighlightIds] = useState<Map<string, number>>(new Map());

  const rawItems = q.data?.items ?? [];
  // Collapse repeats of the same story (same canonical URL or headline) that
  // can arrive across refreshes/cron runs under different dates or sources.
  // Sorting newest-first first means the surviving copy is the freshest.
  const allItems = useMemo(
    () => dedupeNewsItems(sortNewsLatestFirst(rawItems)),
    [rawItems],
  );
  // Topic per headline (derived — `news_cache` has no topic column).
  const topicById = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of allItems) m.set(
        it.id,
        classifyNewsTopic({
          headline: it.headline,
          excerpt: "excerpt" in it ? (it as { excerpt?: string | null }).excerpt : null,
          summary: "summary" in it ? (it as { summary?: string | null }).summary : null,
          source: it.source,
        }),
      );
    return m;
  }, [allItems]);

  // Source / topic options with counts, so the user sees what's available.
  const sourceOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of allItems) {
      const s = (it.source ?? "").trim();
      if (!s) continue;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([source, count]) => ({ source, count }));
  }, [allItems]);

  const topicOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of allItems) {
      const t = topicById.get(it.id) ?? "other";
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return NEWS_TOPICS.filter((t) => counts.has(t.id)).map((t) => ({
      id: t.id as string,
      label: t.label,
      count: counts.get(t.id) ?? 0,
    }));
  }, [allItems, topicById]);

  const items = useMemo(() => {
    const filtered = allItems.filter((it) => {
      if (onlyCited && it.decisions_count === 0) return false;
      if (onlyRelevant && (it.relevance_score ?? 0) < 60) return false;
      if (assetFilter.size > 0) {
        if (!it.asset_classes.some((c) => assetFilter.has(c))) return false;
      }
      if (riskFilter.size > 0) {
        if (!it.risk_levels.some((r) => riskFilter.has(r))) return false;
      }
      if (sourceFilter.size > 0) {
        if (!sourceFilter.has((it.source ?? "").trim())) return false;
      }
      if (topicFilter.size > 0) {
        if (!topicFilter.has(topicById.get(it.id) ?? "other")) return false;
      }
      return true;
    });
    if (sortMode === "relevance") {
      // Portfolio impact first (scored at ingestion against holdings, universe
      // and risk level); newest wins inside an equal score.
      return sortByRelevance(filtered);
    }
    if (sortMode === "reliability") {
      // Composite trust score: credibility weighted 60%, recency 40%.
      const score = (it: (typeof filtered)[number]) => {
        const cred = credibilityFor(it.source).score;
        const rec = recencyFor(it.date, now).score;
        return cred * 0.6 + rec * 0.4;
      };
      return [...filtered].sort((a, b) => score(b) - score(a));
    }
    // Latest first: shared helper keeps this identical to the server ordering.
    return sortNewsLatestFirst(filtered);
  }, [allItems, assetFilter, riskFilter, sourceFilter, topicFilter, topicById, onlyCited, onlyRelevant, sortMode, now]);


  // Timestamp of the freshest headline currently in the reel — lets the user
  // confirm at a glance that newest-first ordering is in effect.
  const newestHeadlineAt = useMemo(() => {
    let max = 0;
    for (const it of allItems) {
      const t = it.fetched_at ? Date.parse(it.fetched_at) : Date.parse(`${it.date}T00:00:00Z`);
      if (Number.isFinite(t) && t > max) max = t;
    }
    return max > 0 ? max : null;
  }, [allItems]);




  // Detect newly-arrived headlines that match current filters and carry a strong sentiment signal,
  // then flash-highlight them in the list and surface a toast notification.
  useEffect(() => {
    if (!q.data) return;
    const currentIds = new Set(allItems.map((i) => i.id));
    if (seenIdsRef.current === null) {
      // First load — seed the seen set without notifying.
      seenIdsRef.current = currentIds;
      return;
    }
    const prevSeen = seenIdsRef.current;
    const strongNew = allItems.filter((it) => {
      if (prevSeen.has(it.id)) return false;
      if (onlyCited && it.decisions_count === 0) return false;
      if (onlyRelevant && (it.relevance_score ?? 0) < 60) return false;
      if (assetFilter.size > 0 && !it.asset_classes.some((c) => assetFilter.has(c))) return false;
      if (riskFilter.size > 0 && !it.risk_levels.some((r) => riskFilter.has(r))) return false;
      const s = it.avg_sentiment;
      return s != null && Math.abs(s) >= STRONG_SENTIMENT_THRESHOLD;
    });
    if (strongNew.length > 0) {
      const ts = Date.now();
      setHighlightIds((prev) => {
        const next = new Map(prev);
        strongNew.forEach((s) => next.set(s.id, ts));
        return next;
      });
      const preview = strongNew.slice(0, 2).map((s) => s.headline).join(" • ");
      const more = strongNew.length > 2 ? ` (+${strongNew.length - 2} more)` : "";
      toast(
        `${strongNew.length} new strong-signal headline${strongNew.length > 1 ? "s" : ""}`,
        { description: preview + more, duration: 8000 },
      );
    }
    seenIdsRef.current = currentIds;
  }, [q.dataUpdatedAt, allItems, assetFilter, riskFilter, onlyCited, q.data]);

  // Age out highlights so they don't linger forever.
  useEffect(() => {
    if (highlightIds.size === 0) return;
    const id = window.setInterval(() => {
      const cutoff = Date.now() - HIGHLIGHT_DURATION_MS;
      setHighlightIds((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [k, t] of next) {
          if (t < cutoff) { next.delete(k); changed = true; }
        }
        return changed ? next : prev;
      });
    }, 5000);
    return () => window.clearInterval(id);
  }, [highlightIds.size]);

  const highlightCount = highlightIds.size;


  function toggle(set: Set<string>, val: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(val)) next.delete(val); else next.add(val);
    setter(next);
  }


  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || items.length === 0) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      if (!paused) {
        // ~24px/s continuous scroll
        el.scrollTop += (dt / 1000) * 24;
        const half = el.scrollHeight / 2;
        if (el.scrollTop >= half) el.scrollTop -= half;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [items.length, paused]);

  // Duplicate items to create a seamless loop.
  const loop = useMemo(() => items.concat(items), [items]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Newspaper className="h-4 w-4 text-primary" />
              Global events reel
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
              {highlightCount > 0 && (
                <button
                  type="button"
                  onClick={() => setHighlightIds(new Map())}
                  className="ml-1 inline-flex items-center gap-1 rounded-full border border-primary/50 bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary shadow-sm transition-colors hover:bg-primary/25"
                  title={`Clear ${highlightCount} new strong-signal highlight${highlightCount > 1 ? "s" : ""}`}
                >
                  <Sparkles className="h-3 w-3" />
                  {highlightCount} new
                </button>
              )}
            </CardTitle>
            <CardDescription>
              Live headlines the AI has been reading, with a note on how each shaped its recent trading decisions.
            </CardDescription>
          </div>
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-1">
              <select
                value={refreshKey}
                onChange={(e) => setRefreshKey(e.target.value as RefreshKey)}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                aria-label="Refresh frequency"
                title="How often the reel auto-refreshes"
              >
                {REFRESH_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>Every {o.label}</option>
                ))}
              </select>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPaused((p) => !p)}
                aria-label={paused ? "Resume scrolling" : "Pause scrolling"}
                title={paused ? "Resume scrolling" : "Pause scrolling"}
              >
                {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  if (refreshing) return;
                  setRefreshing(true);
                  try {
                    // Rebuild the upstream cache first, then re-read it —
                    // otherwise "Refresh now" only re-shows stale rows.
                    const res = await refreshSource({ data: { max: 30 } });
                    if (res.skipped && res.reason) toast.info(res.reason);
                    else {
                      toast.success(`Pulled ${res.headlines} headlines (${res.scored} scored).`);
                      publishRationaleRefresh("news", `${res.headlines} new headlines`);
                    }
                  } catch (err) {
                    toast.error(`Could not fetch new headlines: ${String(err)}`);
                  } finally {
                    setRefreshing(false);
                    await q.refetch();
                  }
                }}
                disabled={q.isFetching || refreshing}
                aria-label="Refresh global news"
                title="Fetch the latest global headlines from source now"
                className="h-8 gap-1.5 px-2 text-xs"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching || refreshing ? "animate-spin" : ""}`} />
                {q.isFetching || refreshing ? "Refreshing…" : "Refresh global news"}
              </Button>
            </div>
            <div
              className="text-right text-[10px] leading-tight text-muted-foreground"
              title={lastUpdated ? formatUkDateTime(lastUpdated) : "Not yet loaded"}
            >
              <div className="font-medium text-foreground">
                {q.isFetching || refreshing
                  ? "Refreshing…"
                  : lastUpdated
                    ? `Last updated ${formatUkTime(lastUpdated)} ${ukZoneAbbr(lastUpdated)} · ${formatAgo(lastUpdated, now)}`
                    : "Last updated —"}
              </div>
              <div>
                {newestHeadlineAt
                  ? `Newest headline ${formatUkTime(newestHeadlineAt)} ${ukZoneAbbr(newestHeadlineAt)}`
                  : "No headlines yet"}
                {" · "}
                {sortMode === "latest"
                  ? "newest first"
                  : sortMode === "relevance"
                    ? "most relevant to your book first"
                    : "most reliable first"}
                {refreshMs === 0 ? " · auto-refresh off" : ""}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2 md:hidden">
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
            aria-expanded={filtersOpen}
          >
            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${filtersOpen ? "rotate-90" : ""}`} />
            Filters & sort
            {activeFilterCount > 0 && (
              <span className="ml-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                {activeFilterCount}
              </span>
            )}
          </button>
          <span className="text-[11px] text-muted-foreground">{items.length} of {allItems.length}</span>
        </div>

        <div className="mt-3">
          <NewsBackfillControls />
          <NewsRelevanceTelemetryCard />
        </div>


        <div className={`mt-3 flex-wrap items-center gap-2 text-[11px] ${filtersOpen ? "flex" : "hidden"} md:flex`}>
          <span className="text-muted-foreground uppercase tracking-wide">Asset:</span>
          {ASSET_CLASSES.map((c) => {
            const active = assetFilter.has(c);
            return (
              <button
                key={c}
                type="button"
                onClick={() => toggle(assetFilter, c, setAssetFilter)}
                className={`rounded-full border px-2 py-0.5 transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
                }`}
              >
                {c}
              </button>
            );
          })}
          <span className="ml-2 text-muted-foreground uppercase tracking-wide">Risk:</span>
          {RISK_LEVELS.map((r) => {
            const active = riskFilter.has(r);
            return (
              <button
                key={r}
                type="button"
                onClick={() => toggle(riskFilter, r, setRiskFilter)}
                className={`rounded-full border px-2 py-0.5 transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
                }`}
              >
                {r}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setOnlyCited((v) => !v)}
            className={`ml-2 rounded-full border px-2 py-0.5 transition-colors ${
              onlyCited
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
            }`}
            title="Only show headlines the AI has cited in a decision"
          >
            Cited only
          </button>
          <button
            type="button"
            onClick={() => setOnlyRelevant((v) => !v)}
            className={`rounded-full border px-2 py-0.5 transition-colors ${
              onlyRelevant
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
            }`}
            title="Only show headlines scored 60+ for likely impact on your holdings, universe and risk level"
          >
            High relevance only
          </button>
          {topicOptions.length > 0 && (
            <div className="flex w-full flex-wrap items-center gap-2">
              <span className="text-muted-foreground uppercase tracking-wide">Topic:</span>
              {topicOptions.map((t) => {
                const active = topicFilter.has(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggle(topicFilter, t.id, setTopicFilter)}
                    className={`rounded-full border px-2 py-0.5 transition-colors ${
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
                    }`}
                    title={`${t.count} headline${t.count === 1 ? "" : "s"}`}
                  >
                    {t.label} <span className="opacity-70">{t.count}</span>
                  </button>
                );
              })}
            </div>
          )}
          {sourceOptions.length > 0 && (
            <div className="flex w-full flex-wrap items-start gap-2">
              <span className="mt-0.5 text-muted-foreground uppercase tracking-wide">Source:</span>
              <div className="flex max-h-24 flex-1 flex-wrap gap-2 overflow-y-auto pr-1">
                {sourceOptions.map((s) => {
                  const active = sourceFilter.has(s.source);
                  return (
                    <button
                      key={s.source}
                      type="button"
                      onClick={() => toggle(sourceFilter, s.source, setSourceFilter)}
                      className={`max-w-[180px] truncate rounded-full border px-2 py-0.5 transition-colors ${
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
                      }`}
                      title={`${s.source} — ${s.count} headline${s.count === 1 ? "" : "s"}`}
                    >
                      {s.source} <span className="opacity-70">{s.count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {(assetFilter.size > 0 || riskFilter.size > 0 || sourceFilter.size > 0 || topicFilter.size > 0 || onlyCited || onlyRelevant) && (
            <button
              type="button"
              onClick={() => {
                setAssetFilter(new Set());
                setRiskFilter(new Set());
                setSourceFilter(new Set());
                setTopicFilter(new Set());
                setOnlyCited(false);
                setOnlyRelevant(false);
              }}
              className="ml-1 text-muted-foreground underline hover:text-foreground"
            >
              Clear
            </button>
          )}

          <span className="ml-auto flex items-center gap-2 text-muted-foreground">
            <label className="flex items-center gap-1 text-[11px]">
              <span className="uppercase tracking-wide">Sort:</span>
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as "latest" | "reliability" | "relevance")}
                className="h-6 rounded-md border border-border bg-background px-1.5 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                title="Sort by newest first, by portfolio relevance (AI-scored against your holdings, universe and risk level), or by a composite of source credibility (60%) and recency (40%)."
              >
                <option value="latest">Latest</option>
                <option value="relevance">Most relevant</option>
                <option value="reliability">Most reliable</option>
              </select>
            </label>
            <span>{items.length} of {allItems.length}</span>
          </span>

        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="h-72 animate-pulse rounded-md bg-muted/40" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {allItems.length === 0
              ? "No recent headlines cached yet. The next hourly run will populate this feed."
              : "No headlines match the current filters."}
          </p>

        ) : (
          <div
            ref={scrollerRef}
            className="relative h-80 overflow-y-auto overscroll-contain pr-1 [mask-image:linear-gradient(to_bottom,transparent,black_4%,black_96%,transparent)] scrollbar-thin"
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            onTouchStart={() => setPaused(true)}
          >

            <ul className="space-y-3 pr-2">
              {loop.map((item, idx) => {
                const tone = sentimentTone(item.avg_sentiment);
                const cred = credibilityFor(item.source);
                const rec = recencyFor(item.date, now);
                const cited = item.decisions_count > 0;
                const isNew = highlightIds.has(item.id);
                const prev = idx > 0 ? loop[idx - 1] : null;
                const showDayHeader = !prev || prev.date !== item.date;
                return (
                  <Fragment key={`${item.id}-${idx}`}>
                    {showDayHeader && item.date && (
                      <li className="sticky top-0 z-10 -mx-2 mb-2 border-y border-border bg-card/95 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
                        {item.date}
                      </li>
                    )}
                  <li
                    className={`relative rounded-md border p-3 transition-colors ${
                      isNew
                        ? "border-primary bg-primary/10 shadow-[0_0_0_1px_var(--primary)] ring-2 ring-primary/40 animate-pulse"
                        : cited
                        ? "border-primary/40 bg-primary/[0.04]"
                        : "border-border bg-card/40"
                    }`}
                  >
                    {isNew && (
                      <span className="absolute -top-2 left-3 inline-flex items-center gap-1 rounded-full border border-primary/60 bg-primary px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-primary-foreground shadow">
                        <Sparkles className="h-2.5 w-2.5" />
                        New signal
                      </span>
                    )}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                          <span>{item.date}</span>
                          {item.source && (
                            item.url ? (
                              <a
                                href={item.url}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="truncate hover:text-foreground hover:underline"
                                title={`Open source: ${item.source}`}
                              >
                                · {item.source}
                              </a>
                            ) : (
                              <span className="truncate">· {item.source}</span>
                            )
                          )}
                          <div className="ml-auto flex flex-wrap items-center gap-1">
                            <Badge variant="outline" className={`border-transparent ${cred.cls}`} title={`Source reliability tier: ${cred.tier}`}>
                              {cred.label}
                            </Badge>
                            <Badge variant="outline" className={`border-transparent ${rec.cls}`} title={`Published ${rec.ageLabel}`}>
                              {rec.label} · {rec.ageLabel}
                            </Badge>
                            <Badge variant="outline" className={`border-transparent ${tone.cls}`}>
                              {tone.label}
                            </Badge>
                            {item.relevance_score != null && (
                              <Badge
                                variant="outline"
                                className={`border-transparent ${relevanceCls(item.relevance_score)}`}
                                title={
                                  item.relevance_reason
                                    ? `${relevanceBandLabel(item.relevance_score)} (${Math.round(item.relevance_score)}/100) — ${item.relevance_reason}`
                                    : `${relevanceBandLabel(item.relevance_score)} (${Math.round(item.relevance_score)}/100)`
                                }
                              >
                                <Target className="mr-1 h-2.5 w-2.5" />
                                {Math.round(item.relevance_score)}
                              </Badge>
                            )}
                          </div>
                        </div>
                        <p className="text-sm font-medium leading-snug text-foreground">
                          {item.url ? (
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="hover:underline"
                            >
                              {item.headline}
                              <ExternalLink className="ml-1 inline h-3 w-3 opacity-70" />
                            </a>
                          ) : (
                            item.headline
                          )}
                        </p>
                        <TranslationBadge
                          originalLanguage={item.original_language}
                          originalHeadline={item.original_headline}
                          confidence={item.translation_confidence}
                          headline={item.headline}
                          className="mt-1"
                        />



                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          {item.url ? (
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/15"
                              title="Verify at original source"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Verify source
                            </a>
                          ) : (
                            <a
                              href={newsSearchUrl(item.headline)}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-1 rounded-sm border border-border bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
                              title="Search this headline on Google News"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Search news
                            </a>
                          )}
                          {cited && (
                            <button
                              type="button"
                              onClick={() => setDetailsId(item.id)}
                              className="inline-flex items-center gap-1 rounded-sm border border-primary/40 bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10"
                              title="Explain sentiment, reliability, and excerpt context before opening the source"
                            >
                              <Info className="h-3 w-3" />
                              View details
                            </button>
                          )}
                        </div>
                        <p className={`mt-1.5 text-xs ${cited ? "text-foreground/80" : "text-muted-foreground"}`}>
                          <span className={`mr-1 font-semibold ${cited ? "text-primary" : "text-muted-foreground"}`}>
                            AI note:
                          </span>
                          {item.note}
                        </p>
                        {item.excerpt && (
                          <blockquote
                            className="mt-1.5 border-l-2 border-primary/40 bg-muted/30 px-2 py-1 text-[11px] italic text-muted-foreground"
                            title={item.source ? `Excerpt from ${item.source}` : "Source excerpt"}
                          >
                            <span className="mr-1 not-italic font-semibold uppercase tracking-wide text-[10px] text-foreground/70">
                              Cited excerpt:
                            </span>
                            “{item.excerpt}”
                            {item.source && (
                              <span className="ml-1 not-italic text-[10px] text-muted-foreground">— {item.source}</span>
                            )}
                            <span className="mt-1 flex items-center gap-2 not-italic">
                              {item.url ? (
                                <a
                                  href={item.url}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  className="inline-flex items-center gap-1 rounded-sm border border-primary/50 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary hover:bg-primary/20"
                                  title={item.source ? `Open the original article at ${item.source}` : "Open the original article"}
                                >
                                  <ExternalLink className="h-3 w-3" />
                                  View source
                                </a>
                              ) : (
                                <a
                                  href={newsSearchUrl(item.headline)}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  className="inline-flex items-center gap-1 rounded-sm border border-border bg-background/60 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground hover:text-foreground"
                                  title="No direct URL available — search this headline on Google News"
                                >
                                  <ExternalLink className="h-3 w-3" />
                                  Search source
                                </a>
                              )}
                              <span className="text-[10px] not-italic text-muted-foreground">
                                Open the original article to verify this excerpt.
                              </span>
                            </span>
                          </blockquote>
                        )}
                        {cited && item.influences.length > 0 && (() => {
                          const isOpen = expanded.has(item.id);
                          return (
                            <div className="mt-2">
                              <button
                                type="button"
                                onClick={() => toggleExpanded(item.id)}
                                className="inline-flex items-center gap-1 rounded-sm border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10"
                                aria-expanded={isOpen}
                              >
                                {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                {isOpen ? "Hide" : "Show"} {item.influences.length} influenced decision{item.influences.length === 1 ? "" : "s"}
                              </button>
                              {isOpen ? (
                                <ul className="mt-2 space-y-2 border-l-2 border-primary/30 pl-3">
                                  {item.influences.map((inf, i) => {
                                    const infTone = sentimentTone(inf.sentiment);
                                    const pct = inf.impact_pct;
                                    const barPct = pct == null ? 0 : Math.max(0, Math.min(100, pct));
                                    const impactCls =
                                      pct == null ? "text-muted-foreground bg-muted"
                                      : pct >= 30 ? "text-primary bg-primary/10"
                                      : pct >= 10 ? "text-foreground bg-muted"
                                      : "text-muted-foreground bg-muted";
                                    return (
                                      <li key={`${inf.decision_id}-${i}`} className="rounded-sm bg-background/60 p-2 text-[11px]">
                                        <div className="mb-1 flex flex-wrap items-center gap-1.5">
                                          <span className="font-semibold text-foreground">{inf.portfolio_name}</span>
                                          <span className="text-muted-foreground">· run {formatUkDate(inf.run_date)}</span>
                                          <RunReportLink runDate={inf.run_date} className="text-[10px]" />
                                          <Badge
                                            variant="outline"
                                            className={`ml-auto border-transparent text-[10px] ${impactCls}`}
                                            title={
                                              pct == null
                                                ? "Contribution weight not available for this decision"
                                                : `Contributed ${pct.toFixed(1)}% of this decision's news-weighted signal (|sentiment| × source weight)`
                                            }
                                          >
                                            Impact {pct == null ? "n/a" : `${pct.toFixed(1)}%`}
                                          </Badge>
                                          <Badge variant="outline" className={`border-transparent text-[10px] ${infTone.cls}`}>
                                            {infTone.label}
                                          </Badge>
                                        </div>
                                        <div
                                          className="mb-1.5 h-1 w-full overflow-hidden rounded-sm bg-muted"
                                          title={
                                            inf.source_weight != null && inf.sentiment != null
                                              ? `sentiment ${inf.sentiment >= 0 ? "+" : ""}${inf.sentiment.toFixed(2)} × source weight ${inf.source_weight.toFixed(2)}`
                                              : "contribution weight"
                                          }
                                        >
                                          <div
                                            className={`h-full ${pct != null && pct >= 30 ? "bg-primary" : "bg-primary/60"}`}
                                            style={{ width: `${barPct}%` }}
                                          />
                                        </div>
                                        {inf.actions.length > 0 ? (
                                          <div className="mb-1 flex flex-wrap gap-1">
                                            {inf.actions.map((a, j) => {
                                              const isBuy = a.action.toUpperCase().startsWith("BUY");
                                              const isSell = a.action.toUpperCase().startsWith("SELL");
                                              const cls = isBuy
                                                ? "border-primary/50 bg-primary/10 text-primary"
                                                : isSell
                                                ? "border-destructive/50 bg-destructive/10 text-destructive"
                                                : "border-border bg-muted text-foreground";
                                              return (
                                                <span key={j} className={`rounded-sm border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
                                                  {a.action} {a.symbol}
                                                  {a.qty != null ? ` × ${a.qty}` : ""}
                                                </span>
                                              );
                                            })}
                                          </div>
                                        ) : (
                                          <div className="mb-1 text-[10px] italic text-muted-foreground">HOLD — no trades executed</div>
                                        )}
                                        {inf.rationale && (
                                          <p className="text-[11px] leading-snug text-muted-foreground">
                                            <span className="font-semibold text-foreground/80">Rationale: </span>
                                            {inf.rationale}
                                          </p>
                                        )}
                                      </li>
                                    );
                                  })}
                                </ul>
                              ) : (
                                <div className="mt-1 flex flex-wrap gap-1.5">
                                  {item.influences.slice(0, 4).map((inf, i) => (
                                    <span
                                      key={i}
                                      className="inline-flex flex-wrap items-center gap-1 rounded-sm border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                    >
                                      <span>{inf.portfolio_name} · {formatUkDate(inf.run_date)}</span>
                                      <span className="text-foreground">{adjustedSummary(inf.actions)}</span>
                                      <RunReportLink runDate={inf.run_date} />
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  </li>
                  </Fragment>
                );
              })}
            </ul>
            {/* Infinite-scroll sentinel — observed to auto-load older events. */}
            {hasMore && (
              <div
                ref={sentinelRef}
                aria-hidden="true"
                className="h-8 w-full"
              />
            )}
            {(q.isFetching || !hasMore) && allItems.length > 0 && (
              <div className="py-2 text-center text-[11px] italic text-muted-foreground">
                {q.isFetching
                  ? "Loading older events…"
                  : "No older cached events"}
              </div>
            )}
          </div>
        )}
        {!q.isLoading && allItems.length > 0 && (
          <div className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <span>
              Showing {allItems.length} headline{allItems.length === 1 ? "" : "s"} from the last {sinceDays} day{sinceDays === 1 ? "" : "s"}
            </span>
            {hasMore && (
              <Button
                size="sm"
                variant="outline"
                onClick={loadMore}
                disabled={q.isFetching}
                className="h-7 text-xs"
                title="Older events also auto-load as you scroll to the bottom of the reel"
              >
                {q.isFetching ? "Loading…" : "Load more"}
              </Button>
            )}
          </div>
        )}

      </CardContent>
      <Dialog open={detailsId !== null} onOpenChange={(o) => !o && setDetailsId(null)}>
        <DialogContent className="max-w-lg">
          {(() => {
            const item = allItems.find((i) => i.id === detailsId);
            if (!item) return null;
            const tone = sentimentTone(item.avg_sentiment);
            const cred = credibilityFor(item.source);
            const rec = recencyFor(item.date, now);
            const reliability = Math.round(cred.score * 0.6 + rec.score * 0.4);
            const s = item.avg_sentiment;
            const sentimentStrength =
              s == null ? "unscored"
              : Math.abs(s) >= STRONG_SENTIMENT_THRESHOLD ? "strong"
              : Math.abs(s) >= 0.15 ? "moderate"
              : "weak";
            const totalImpact = item.influences.reduce(
              (acc, inf) => acc + (inf.impact_pct ?? 0),
              0,
            );
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="text-base leading-snug">{item.headline}</DialogTitle>
                  <DialogDescription>
                    {item.source ? `${item.source} · ` : ""}{item.date} · {rec.ageLabel}
                  </DialogDescription>
                  <TranslationBadge
                    originalLanguage={item.original_language}
                    originalHeadline={item.original_headline}
                    confidence={item.translation_confidence}
                    headline={item.headline}
                    className="mt-2"
                  />




                </DialogHeader>
                <div className="space-y-3 text-sm">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline" className={`border-transparent ${tone.cls}`}>{tone.label}</Badge>
                    <Badge variant="outline" className={`border-transparent ${cred.cls}`}>{cred.label} · {cred.tier}</Badge>
                    <Badge variant="outline" className={`border-transparent ${rec.cls}`}>{rec.label}</Badge>
                    <Badge variant="outline" className="border-transparent bg-primary/10 text-primary">
                      Reliability {reliability}
                    </Badge>
                  </div>
                  {item.original_language && item.original_headline && (
                    <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.06] p-3 text-xs leading-relaxed">
                      <div className="mb-1 flex items-center justify-between gap-2 font-semibold uppercase tracking-wide text-[10px] text-amber-600 dark:text-amber-400">
                        <span>Translation</span>
                        {typeof item.translation_confidence === "number" && (
                          <span className="rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px]">
                            {Math.round(Math.max(0, Math.min(1, item.translation_confidence)) * 100)}% confidence
                          </span>
                        )}
                      </div>
                      <p className="text-muted-foreground">
                        Detected language:{" "}
                        <span className="font-semibold text-foreground">{item.original_language}</span>.
                        {typeof item.translation_confidence === "number" ? (
                          <>
                            {" "}
                            Model self-reported translation confidence is{" "}
                            <span className="font-semibold text-foreground">
                              {Math.round(Math.max(0, Math.min(1, item.translation_confidence)) * 100)}%
                            </span>{" "}
                            — {item.translation_confidence >= 0.85
                              ? "treat as reliable."
                              : item.translation_confidence >= 0.6
                              ? "usable but double-check nuance."
                              : "verify against the original before acting on it."}
                          </>
                        ) : (
                          <> Confidence not reported by the model.</>
                        )}
                      </p>
                      <p className="mt-1.5 italic text-muted-foreground">
                        Original: “{item.original_headline}”
                      </p>
                    </div>
                  )}

                  <div className="rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed">
                    <div className="mb-1 font-semibold uppercase tracking-wide text-[10px] text-foreground/70">
                      Sentiment & reliability
                    </div>
                    <p className="text-muted-foreground">
                      This headline reads as a <span className="font-semibold text-foreground">{sentimentStrength}</span>{" "}
                      {s == null ? "" : s > 0 ? "bullish" : s < 0 ? "bearish" : "neutral"} signal
                      {s != null && ` (score ${s >= 0 ? "+" : ""}${s.toFixed(2)})`}. Source credibility is{" "}
                      <span className="font-semibold text-foreground">{cred.tier}</span> ({cred.score}/100) and the story is{" "}
                      <span className="font-semibold text-foreground">{rec.ageLabel}</span>. Overall reliability blends
                      credibility (60%) and recency (40%) into a composite score of{" "}
                      <span className="font-semibold text-foreground">{reliability}/100</span>.
                    </p>
                  </div>
                  <div className="rounded-md border border-primary/30 bg-primary/[0.04] p-3 text-xs leading-relaxed">
                    <div className="mb-1 font-semibold uppercase tracking-wide text-[10px] text-primary">
                      Excerpt context
                    </div>
                    {item.excerpt ? (
                      <blockquote className="border-l-2 border-primary/40 pl-2 italic text-muted-foreground">
                        “{item.excerpt}”
                      </blockquote>
                    ) : (
                      <p className="italic text-muted-foreground">
                        No excerpt was captured — the AI note below summarises how this headline was interpreted.
                      </p>
                    )}
                    <p className="mt-2 text-muted-foreground">
                      <span className="mr-1 font-semibold text-foreground/80">AI note:</span>
                      {item.note}
                    </p>
                  </div>
                  {item.influences.length > 0 && (
                    <div className="rounded-md border border-border bg-card/40 p-3 text-xs">
                      <div className="mb-1 font-semibold uppercase tracking-wide text-[10px] text-foreground/70">
                        Influenced {item.influences.length} decision{item.influences.length === 1 ? "" : "s"}
                        {totalImpact > 0 ? ` · ${totalImpact.toFixed(1)}% total impact` : ""}
                      </div>
                      <ul className="space-y-1 text-muted-foreground">
                        {item.influences.slice(0, 4).map((inf, i) => (
                          <li key={i} className="flex flex-wrap items-center gap-1.5">
                            <span className="text-foreground">{inf.portfolio_name}</span>
                            <span>· {inf.run_date}</span>
                            {inf.actions.length > 0 && (
                              <span className="text-foreground">
                                · {inf.actions.map((a) => `${a.action} ${a.symbol}`).join(", ")}
                              </span>
                            )}
                            {inf.impact_pct != null && (
                              <span className="ml-auto text-primary">{inf.impact_pct.toFixed(1)}%</span>
                            )}
                          </li>
                        ))}
                        {item.influences.length > 4 && (
                          <li className="italic">+ {item.influences.length - 4} more…</li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
                <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
                  <Button variant="ghost" size="sm" onClick={() => setDetailsId(null)}>
                    Close
                  </Button>
                  <Button asChild size="sm">
                    <a
                      href={citationHref(item)}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      <ExternalLink className="mr-1 h-3.5 w-3.5" />
                      {item.url ? "Open source article" : "Search source"}
                    </a>
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
