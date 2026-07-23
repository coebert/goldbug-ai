import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getGlobalNewsReel } from "@/lib/trading.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, ExternalLink, Newspaper, Pause, Play, RefreshCw } from "lucide-react";

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

  const q = useQuery({
    queryKey: ["global-news-reel"],
    queryFn: () => fetchReel(),
    staleTime: refreshMs > 0 ? refreshMs : 5 * 60_000,
    refetchInterval: refreshMs > 0 ? refreshMs : false,
  });

  // "Now" tick so the "updated Xs ago" label stays live.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);
  const lastUpdated = q.dataUpdatedAt || null;


  const [paused, setPaused] = useState(false);
  const [assetFilter, setAssetFilter] = useState<Set<string>>(new Set());
  const [riskFilter, setRiskFilter] = useState<Set<string>>(new Set());
  const [onlyCited, setOnlyCited] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const allItems = q.data?.items ?? [];
  const items = useMemo(() => {
    return allItems.filter((it) => {
      if (onlyCited && it.decisions_count === 0) return false;
      if (assetFilter.size > 0) {
        if (!it.asset_classes.some((c) => assetFilter.has(c))) return false;
      }
      if (riskFilter.size > 0) {
        if (!it.risk_levels.some((r) => riskFilter.has(r))) return false;
      }
      return true;
    });
  }, [allItems, assetFilter, riskFilter, onlyCited]);

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
                variant="ghost"
                onClick={() => q.refetch()}
                disabled={q.isFetching}
                aria-label="Refresh news"
                title="Refresh now"
              >
                <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
              </Button>
            </div>
            <div className="text-[10px] text-muted-foreground" title={lastUpdated ? new Date(lastUpdated).toLocaleString() : "Not yet loaded"}>
              {q.isFetching ? "Refreshing…" : `Updated ${formatAgo(lastUpdated, now)}`}
              {refreshMs === 0 ? " · auto-refresh off" : ""}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
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
          {(assetFilter.size > 0 || riskFilter.size > 0 || onlyCited) && (
            <button
              type="button"
              onClick={() => { setAssetFilter(new Set()); setRiskFilter(new Set()); setOnlyCited(false); }}
              className="ml-1 text-muted-foreground underline hover:text-foreground"
            >
              Clear
            </button>
          )}
          <span className="ml-auto text-muted-foreground">
            {items.length} of {allItems.length}
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
            className="relative h-80 overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_8%,black_92%,transparent)]"
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
          >
            <ul className="space-y-3 pr-2">
              {loop.map((item, idx) => {
                const tone = sentimentTone(item.avg_sentiment);
                const cited = item.decisions_count > 0;
                return (
                  <li
                    key={`${item.id}-${idx}`}
                    className={`rounded-md border p-3 transition-colors ${
                      cited ? "border-primary/40 bg-primary/[0.04]" : "border-border bg-card/40"
                    }`}
                  >
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
                          <Badge variant="outline" className={`ml-auto border-transparent ${tone.cls}`}>
                            {tone.label}
                          </Badge>
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
                              href={`https://www.google.com/search?q=${encodeURIComponent(item.headline)}&tbm=nws`}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-1 rounded-sm border border-border bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
                              title="Search this headline on Google News"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Search news
                            </a>
                          )}
                        </div>
                        <p className={`mt-1.5 text-xs ${cited ? "text-foreground/80" : "text-muted-foreground"}`}>
                          <span className={`mr-1 font-semibold ${cited ? "text-primary" : "text-muted-foreground"}`}>
                            AI note:
                          </span>
                          {item.note}
                        </p>
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
                                    return (
                                      <li key={`${inf.decision_id}-${i}`} className="rounded-sm bg-background/60 p-2 text-[11px]">
                                        <div className="mb-1 flex flex-wrap items-center gap-1.5">
                                          <span className="font-semibold text-foreground">{inf.portfolio_name}</span>
                                          <span className="text-muted-foreground">· run {inf.run_date}</span>
                                          <Badge variant="outline" className={`ml-auto border-transparent text-[10px] ${infTone.cls}`}>
                                            {infTone.label}
                                          </Badge>
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
                                      className="rounded-sm border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                    >
                                      {inf.portfolio_name} · {inf.run_date}
                                      {inf.actions.length > 0 && (
                                        <span className="ml-1 text-foreground">
                                          {inf.actions.map((a) => `${a.action} ${a.symbol}`).join(", ")}
                                        </span>
                                      )}
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
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
