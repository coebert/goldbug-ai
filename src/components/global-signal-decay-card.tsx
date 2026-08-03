import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getGlobalSignalDecay } from "@/lib/insights.functions";
import { Activity, TrendingDown, TrendingUp } from "lucide-react";
import { POLL } from "@/lib/query-keys";

const LABELS: Record<string, string> = {
  sma_trend: "SMA trend",
  rsi: "RSI",
  price_change: "Price change",
  news_sentiment: "News sentiment",
  volatility: "Volatility",
};

export function GlobalSignalDecayCard() {
  const fetchFn = useServerFn(getGlobalSignalDecay);
  const { data, isLoading } = useQuery({
    queryKey: ["global-signal-decay"],
    queryFn: () => fetchFn(),
    staleTime: 60_000,
    refetchInterval: POLL.SLOW,
  });

  const rows = data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4" /> Signal decay — all portfolios
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Which signals are earning their keep across every portfolio (rolling 30d).
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!isLoading && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No signal performance recorded yet. Metrics populate once trades have 5-day outcomes.
          </p>
        )}
        {rows.map((r) => {
          const hit = r.hit_rate != null ? Math.round(Number(r.hit_rate) * 100) : null;
          const edge = r.avg_edge_bps != null ? Number(r.avg_edge_bps) : null;
          const good = hit != null && hit >= 55;
          const bad = hit != null && hit < 45;
          const Icon = edge != null && edge >= 0 ? TrendingUp : TrendingDown;
          return (
            <div key={r.signal_name} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{LABELS[r.signal_name] ?? r.signal_name}</span>
                <span className={good ? "text-emerald-500" : bad ? "text-red-500" : "text-muted-foreground"}>
                  <Icon className="mr-1 inline h-3 w-3" />
                  {hit == null ? "—" : `${hit}% hit`} · {edge == null ? "—" : `${edge >= 0 ? "+" : ""}${edge.toFixed(0)} bps`}
                </span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className={good ? "h-full bg-emerald-500" : bad ? "h-full bg-red-500" : "h-full bg-primary"}
                  style={{ width: `${hit ?? 0}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {r.samples} sample{r.samples === 1 ? "" : "s"} across {r.portfolio_count} portfolio{r.portfolio_count === 1 ? "" : "s"} · avg weight {r.weight_avg != null ? Number(r.weight_avg).toFixed(0) : "—"}
              </p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
