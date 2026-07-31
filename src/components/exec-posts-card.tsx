import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { MessageSquare } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getExecPostTracker, type ExecPostTracker } from "@/lib/exec-posts.functions";

function tone(score: number | null): string {
  if (score == null) return "text-muted-foreground";
  if (score > 0.1) return "text-emerald-500";
  if (score < -0.1) return "text-destructive";
  return "text-muted-foreground";
}

export function ExecPostsCard() {
  const fetchTracker = useServerFn(getExecPostTracker);
  const { data, isLoading } = useQuery<ExecPostTracker>({
    queryKey: ["exec-post-tracker"],
    queryFn: () => fetchTracker({ data: { sinceDays: 7 } }),
    staleTime: 5 * 60_000,
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquare className="h-4 w-4 text-primary" aria-hidden="true" />
          CEO posts the AI is tracking
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Posts by figures like Elon Musk can move a share price within minutes. Reported posts are
          scored and nudge the AI&apos;s sentiment for the affected symbols.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-1.5">
          {(data?.tracked ?? []).map((t) => (
            <Badge key={t.name} variant="secondary" className="text-[10px]">
              {t.name} · {t.symbols[0]}
            </Badge>
          ))}
        </div>

        {data && data.signals.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {data.signals.slice(0, 6).map((s) => (
              <div key={s.symbol} className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">{s.symbol}</span>
                  <span className={`text-sm font-semibold tabular-nums ${tone(s.score)}`}>
                    {s.score > 0 ? "+" : ""}
                    {s.score.toFixed(2)}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {s.posts} post{s.posts === 1 ? "" : "s"} · {s.executives.join(", ")}
                </p>
              </div>
            ))}
          </div>
        ) : null}

        <div className="space-y-2">
          {isLoading ? (
            <p className="text-xs text-muted-foreground">Loading tracked posts…</p>
          ) : (data?.posts.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground">
              No market-moving posts picked up in the last 7 days. Monitoring continues each hour.
            </p>
          ) : (
            data!.posts.slice(0, 8).map((p, i) => (
              <div key={`${p.headline}-${i}`} className="rounded-lg border border-border/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">
                    {p.executive_name} {p.handle}
                  </Badge>
                  {p.symbols.slice(0, 3).map((sym) => (
                    <Badge key={sym} variant="secondary" className="text-[10px]">
                      {sym}
                    </Badge>
                  ))}
                  <span className={`ml-auto text-xs font-semibold tabular-nums ${tone(p.sentiment)}`}>
                    {p.sentiment == null ? "unscored" : p.sentiment.toFixed(2)}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-snug">
                  {p.url ? (
                    <a href={p.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                      {p.headline}
                    </a>
                  ) : (
                    p.headline
                  )}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {p.source ?? "news"} · {p.date ?? ""}
                </p>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
