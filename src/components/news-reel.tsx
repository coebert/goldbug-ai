import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getGlobalNewsReel } from "@/lib/trading.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink, Newspaper, Pause, Play, RefreshCw } from "lucide-react";

function sentimentTone(v: number | null) {
  if (v == null) return { label: "unscored", cls: "text-muted-foreground bg-muted" };
  if (v > 0.15) return { label: `bullish +${v.toFixed(2)}`, cls: "text-primary bg-primary/10" };
  if (v < -0.15) return { label: `bearish ${v.toFixed(2)}`, cls: "text-destructive bg-destructive/10" };
  return { label: `neutral ${v >= 0 ? "+" : ""}${v.toFixed(2)}`, cls: "text-foreground bg-muted" };
}

export function NewsReel() {
  const fetchReel = useServerFn(getGlobalNewsReel);
  const q = useQuery({
    queryKey: ["global-news-reel"],
    queryFn: () => fetchReel(),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  const [paused, setPaused] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const items = useMemo(() => q.data?.items ?? [], [q.data]);

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
          <div className="flex items-center gap-1">
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
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="h-72 animate-pulse rounded-md bg-muted/40" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No recent headlines cached yet. The next hourly run will populate this feed.
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
                          {item.source && <span className="truncate">· {item.source}</span>}
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
                        <p className={`mt-1.5 text-xs ${cited ? "text-foreground/80" : "text-muted-foreground"}`}>
                          <span className={`mr-1 font-semibold ${cited ? "text-primary" : "text-muted-foreground"}`}>
                            AI note:
                          </span>
                          {item.note}
                        </p>
                        {cited && item.influences.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
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
