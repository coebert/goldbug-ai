import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { BookOpen, Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { runBatchBacktestLessons } from "@/lib/batch-lessons.functions";

export function BatchLessonsCard() {
  const run = useServerFn(runBatchBacktestLessons);
  const m = useMutation({
    mutationFn: () => run(),
    onSuccess: (r) => {
      toast.success("Batch backtest complete", {
        description: `${r.configs_run} strategies over ${r.from}→${r.to} · ${r.lessons_written} lesson sets written`,
      });
    },
    onError: (e: Error) => toast.error("Batch backtest failed", { description: e.message }),
  });

  return (
    <Card className="border-primary/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="h-4 w-4 text-primary" /> Batch backtest — learn from 5 years of history
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Runs the rule-based backtester across every combination of risk level
          (conservative / balanced / aggressive), rebalance cadence (monthly / quarterly)
          and concentration (top-4 / 6 / 8) over the last 5 years — 18 strategies in total.
          Aggregates the results per historical regime window and writes one lesson set per
          runtime regime (bull_quiet, bull_volatile, correction, bear, crisis, recovery) plus
          a general bucket. Lessons are pooled across all your portfolios and used by the AI
          on every future decision.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => m.mutate()} disabled={m.isPending} className="gap-2">
            <Sparkles className={`h-4 w-4 ${m.isPending ? "animate-pulse" : ""}`} />
            {m.isPending ? "Running 18 backtests + reflecting…" : "Run batch backtest & learn"}
          </Button>
          <span className="text-xs text-muted-foreground">Typically takes 30–90 seconds.</span>
        </div>
        {m.isSuccess && m.data && (
          <Alert>
            <AlertTitle className="flex flex-wrap items-center gap-2">
              Written {m.data.lessons_written} lesson sets
              {m.data.regimes_covered.map((r) => (
                <Badge key={r} variant="secondary" className="font-mono text-[10px]">{r}</Badge>
              ))}
            </AlertTitle>
            <AlertDescription className="space-y-2">
              <div className="text-xs text-muted-foreground">
                Window {m.data.from} → {m.data.to} · {m.data.configs_run} configs · {(m.data.duration_ms / 1000).toFixed(1)}s
              </div>
              <div className="max-h-56 overflow-y-auto rounded border text-xs">
                <table className="w-full">
                  <thead className="sticky top-0 bg-muted/60">
                    <tr>
                      <th className="p-2 text-left">Config</th>
                      <th className="p-2 text-right">CAGR</th>
                      <th className="p-2 text-right">Max DD</th>
                      <th className="p-2 text-right">Sharpe</th>
                      <th className="p-2 text-right">vs SPY</th>
                      <th className="p-2 text-right">Trades</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.data.per_config_summary
                      .slice()
                      .sort((a, b) => b.sharpe - a.sharpe)
                      .map((row) => (
                        <tr key={row.config} className="border-t">
                          <td className="p-2 font-mono">{row.config}</td>
                          <td className="p-2 text-right tabular-nums">{row.cagr_pct.toFixed(1)}%</td>
                          <td className="p-2 text-right tabular-nums text-destructive">{row.dd_pct.toFixed(1)}%</td>
                          <td className="p-2 text-right tabular-nums">{row.sharpe.toFixed(2)}</td>
                          <td className={`p-2 text-right tabular-nums ${row.vs_spy_pct >= 0 ? "text-emerald-500" : "text-destructive"}`}>
                            {row.vs_spy_pct >= 0 ? "+" : ""}{row.vs_spy_pct.toFixed(1)}%
                          </td>
                          <td className="p-2 text-right tabular-nums">{row.trades}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
