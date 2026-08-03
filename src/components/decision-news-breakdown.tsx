import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getDecisionNewsBreakdown } from "@/lib/trading.functions";
import { SectionCard, SectionCardBody } from "@/components/ui/section-card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { ListSkeleton } from "@/components/ui/card-skeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, ChevronUp, ExternalLink, Layers, Newspaper, RefreshCw } from "lucide-react";
import { JargonText } from "@/components/jargon-text";
import { POLL } from "@/lib/query-keys";

function tone(v: number | null) {
  if (v == null) return { label: "unscored", cls: "text-muted-foreground bg-muted" };
  if (v > 0.15) return { label: `+${v.toFixed(2)}`, cls: "text-primary bg-primary/10" };
  if (v < -0.15) return { label: v.toFixed(2), cls: "text-destructive bg-destructive/10" };
  return { label: `${v >= 0 ? "+" : ""}${v.toFixed(2)}`, cls: "text-foreground bg-muted" };
}

function actionCls(a: string) {
  const u = a.toUpperCase();
  if (u === "BUY") return "text-primary bg-primary/10 border-primary/30";
  if (u === "SELL") return "text-destructive bg-destructive/10 border-destructive/30";
  return "text-muted-foreground bg-muted border-border";
}

export function DecisionNewsBreakdown() {
  const fetchFn = useServerFn(getDecisionNewsBreakdown);
  const q = useQuery({
    queryKey: ["decision-news-breakdown"],
    queryFn: () => fetchFn(),
    staleTime: 2 * 60_000,
    refetchInterval: POLL.SLOW,
  });

  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const portfolios = useMemo(() => {
    const seen = new Map<string, string>();
    for (const it of items) seen.set(it.portfolio_id, it.portfolio_name);
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [items]);

  const [portfolioFilter, setPortfolioFilter] = useState<string>("all");
  const [onlyWithNews, setOnlyWithNews] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sectionOpen, setSectionOpen] = useState(false);

  const visible = useMemo(() => {
    return items.filter((it) => {
      if (portfolioFilter !== "all" && it.portfolio_id !== portfolioFilter) return false;
      if (onlyWithNews && it.top_news.length === 0) return false;
      return true;
    });
  }, [items, portfolioFilter, onlyWithNews]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <SectionCard>
      <button
        type="button"
        onClick={() => setSectionOpen((v) => !v)}
        aria-expanded={sectionOpen}
        className="flex w-full items-start justify-between gap-3 p-6 text-left"
      >
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4 text-primary" />
            Decision → news breakdown
          </CardTitle>
          <CardDescription className="mt-1.5">
            Each recent decision mapped to the specific headlines that most influenced the AI's take (ranked by sentiment strength).
          </CardDescription>
        </div>
        {sectionOpen ? (
          <ChevronUp className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {sectionOpen && (
        <CardHeader className="pt-0">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="uppercase tracking-wide text-muted-foreground">Portfolio:</span>
            <button
              type="button"
              onClick={() => setPortfolioFilter("all")}
              className={`rounded-full border px-2 py-0.5 ${
                portfolioFilter === "all"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
              }`}
            >
              all
            </button>
            {portfolios.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPortfolioFilter(p.id)}
                className={`rounded-full border px-2 py-0.5 ${
                  portfolioFilter === p.id
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
                }`}
              >
                {p.name}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setOnlyWithNews((v) => !v)}
              className={`ml-2 rounded-full border px-2 py-0.5 ${
                onlyWithNews
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
              }`}
              title="Hide decisions that cited no news"
            >
              News-cited only
            </button>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 px-2"
              onClick={() => q.refetch()}
              disabled={q.isFetching}
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
            </Button>
            <span className="w-full text-muted-foreground">
              {visible.length} of {items.length} decisions
            </span>
          </div>
        </CardHeader>
      )}
      {sectionOpen && (
      <CardContent>
        {q.isError ? (
          <ErrorState
            description={
              q.error instanceof Error
                ? q.error.message
                : "The decisions feed returned an error."
            }
            onRetry={() => q.refetch()}
            retrying={q.isFetching}
          />
        ) : q.isLoading ? (
          <ListSkeleton rows={4} withAvatar={false} />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<Newspaper />}
            title={
              items.length === 0
                ? "No recent decisions yet"
                : "No decisions match the current filters"
            }
            description={
              items.length === 0
                ? "The next scheduled AI run will populate this panel."
                : "Clear filters or wait for the next AI run."
            }
            compact
          />
        ) : (
          <ul className="space-y-3">
            {visible.map((it) => {
              const isOpen = expanded.has(it.decision_id);
              return (
                <li key={it.decision_id} className="rounded-md border border-border bg-card/40">
                  <button
                    type="button"
                    onClick={() => toggle(it.decision_id)}
                    className="flex w-full items-start gap-2 p-3 text-left hover:bg-muted/30"
                    aria-expanded={isOpen}
                  >
                    {isOpen ? (
                      <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                        <span>{it.run_date}</span>
                        <span className="truncate">· {it.portfolio_name}</span>
                        <Badge variant="outline" className="ml-auto border-transparent bg-muted text-foreground">
                          {it.top_news.length} of {it.total_news_considered} news cited
                        </Badge>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {it.actions.length === 0 ? (
                          <span className="text-xs text-muted-foreground">HOLD across the board</span>
                        ) : (
                          it.actions.map((a, i) => (
                            <span
                              key={i}
                              className={`rounded-sm border px-1.5 py-0.5 text-[11px] font-medium ${actionCls(a.action)}`}
                            >
                              {a.action.toUpperCase()} {a.symbol}
                              {a.qty != null && ` × ${a.qty}`}
                            </span>
                          ))
                        )}
                      </div>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="border-t border-border/60 p-3 pt-2">
                      {it.rationale && (
                        <p className="mb-2 text-xs text-foreground/80">
                          <span className="mr-1 font-semibold text-primary">Rationale:</span>
                          <JargonText>{it.rationale}</JargonText>
                        </p>
                      )}
                      {it.top_news.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No news items were cited by this decision.
                        </p>
                      ) : (
                        <ol className="space-y-1.5">
                          {it.top_news.map((n, i) => {
                            const t = tone(n.sentiment);
                            return (
                              <li
                                key={i}
                                className="flex items-start gap-2 rounded-sm border border-border/60 bg-background/60 p-2"
                              >
                                <span className="mt-0.5 shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                                  #{i + 1}
                                </span>
                                <div className="min-w-0 flex-1">
                                  <div className="mb-0.5 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                                    {n.source && <span className="truncate">{n.source}</span>}
                                    <Badge
                                      variant="outline"
                                      className={`ml-auto border-transparent ${t.cls}`}
                                    >
                                      {t.label}
                                    </Badge>
                                  </div>
                                  {n.url ? (
                                    <a
                                      href={n.url}
                                      target="_blank"
                                      rel="noreferrer noopener"
                                      className="text-xs font-medium leading-snug text-foreground hover:underline"
                                    >
                                      {n.headline}
                                      <ExternalLink className="ml-1 inline h-3 w-3 opacity-70" />
                                    </a>
                                  ) : (
                                    <p className="text-xs font-medium leading-snug text-foreground">
                                      {n.headline}
                                    </p>
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ol>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      )}
    </SectionCard>
  );
}
