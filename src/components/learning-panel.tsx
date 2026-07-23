import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getPortfolioLearning } from "@/lib/trading.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Brain, TrendingUp, TrendingDown, Sparkles } from "lucide-react";

export function LearningPanel({ portfolioId }: { portfolioId: string }) {
  const fn = useServerFn(getPortfolioLearning);
  const q = useQuery({
    queryKey: ["learning", portfolioId],
    queryFn: () => fn({ data: { portfolio_id: portfolioId } }),
  });

  if (q.isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Brain className="h-4 w-4 text-primary" /> Learning memory
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">Loading…</CardContent>
      </Card>
    );
  }
  if (q.isError || !q.data) return null;

  const { stats, lessons, lessons_as_of, as_of } = q.data;
  const wr = stats.win_rate != null ? `${(stats.win_rate * 100).toFixed(0)}%` : "—";
  const ar = stats.avg_return_pct != null ? `${stats.avg_return_pct.toFixed(2)}%` : "—";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-primary" /> Learning memory
          </span>
          <span className="text-xs font-normal text-muted-foreground">as of {as_of}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Trades reviewed" value={String(stats.evaluable)} />
          <Stat label={`Win rate (${stats.horizon_days}d fwd)`} value={wr} />
          <Stat label="Avg return" value={ar} />
          <Stat label="Window" value={`${stats.window_days}d`} />
        </div>

        {(stats.best || stats.worst) && (
          <div className="grid gap-2 sm:grid-cols-2">
            {stats.best && (
              <div className="flex items-center gap-2 rounded-md border p-2 text-sm">
                <TrendingUp className="h-4 w-4 text-primary" />
                <span className="text-muted-foreground">Best call:</span>
                <span className="font-medium">{stats.best.symbol}</span>
                <span className="ml-auto text-primary">+{stats.best.return_pct.toFixed(2)}%</span>
              </div>
            )}
            {stats.worst && (
              <div className="flex items-center gap-2 rounded-md border p-2 text-sm">
                <TrendingDown className="h-4 w-4 text-destructive" />
                <span className="text-muted-foreground">Worst call:</span>
                <span className="font-medium">{stats.worst.symbol}</span>
                <span className="ml-auto text-destructive">{stats.worst.return_pct.toFixed(2)}%</span>
              </div>
            )}
          </div>
        )}

        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-primary" />
            Lessons the AI is applying
            {lessons_as_of && (
              <span className="text-xs font-normal text-muted-foreground">
                (updated {lessons_as_of})
              </span>
            )}
          </div>
          {lessons.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Not enough trade outcomes yet — the AI needs at least 5 evaluable trades before it writes lessons.
            </p>
          ) : (
            <ol className="space-y-2 text-sm">
              {lessons.map((l, i) => (
                <li key={i} className="flex gap-2 rounded-md border bg-muted/40 p-2">
                  <span className="text-muted-foreground">{i + 1}.</span>
                  <span>{l}</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        {stats.per_symbol.length > 0 && (
          <div>
            <div className="mb-2 text-sm font-medium">Per-symbol track record</div>
            <div className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
              {stats.per_symbol.map((p) => (
                <div key={p.symbol} className="flex items-center justify-between rounded border px-2 py-1">
                  <span className="font-medium">{p.symbol}</span>
                  <span className="text-muted-foreground">
                    {p.n} · {(p.win_rate * 100).toFixed(0)}% win ·{" "}
                    <span className={p.avg_return_pct >= 0 ? "text-primary" : "text-destructive"}>
                      {p.avg_return_pct >= 0 ? "+" : ""}
                      {p.avg_return_pct.toFixed(2)}%
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold">{value}</div>
    </div>
  );
}
