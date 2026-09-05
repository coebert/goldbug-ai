import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Brain, RefreshCw } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/layout/page-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { fitDecisionModel, getDecisionModel } from "@/lib/decision-model.functions";

export const Route = createFileRoute("/decision-model")({
  component: DecisionModelPage,
  head: () => ({
    meta: [
      { title: "Learned decision model — fitted on your trading history" },
      {
        name: "description",
        content:
          "See the trading model fitted from your own past decisions: which signals actually made money, how well it holds up out of sample, and today's ranking.",
      },
      { property: "og:title", content: "Learned decision model" },
      {
        property: "og:description",
        content:
          "The signal weights measured from your own trading history, with an out-of-sample check on whether the edge is real.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const BUCKET_LABELS: Record<string, string> = {
  sma_trend: "Trend",
  rsi: "Overbought / oversold",
  price_change: "Recent price move",
  news_sentiment: "News",
  volatility: "Volatility",
};

function pct(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}%`;
}
function num(v: number | null | undefined, digits = 3): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(digits);
}

function DecisionModelPage() {
  const load = useServerFn(getDecisionModel);
  const fit = useServerFn(fitDecisionModel);
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["decision-model"],
    queryFn: () => load(),
  });

  const refit = useMutation({
    mutationFn: (realMoneyOnly: boolean) => fit({ data: { horizonDays: 5, realMoneyOnly } }),
    onSuccess: (res) => {
      setMessage(res.ok ? res.model.note : res.error);
      void qc.invalidateQueries({ queryKey: ["decision-model"] });
    },
    onError: (e: unknown) => setMessage(e instanceof Error ? e.message : String(e)),
  });

  const model = data?.model ?? null;
  const features = data?.features ?? [];
  const test = model?.metrics?.test;
  const baseline = model?.metrics?.baseline_test;

  return (
    <>
      <AppHeader />
      <PageShell
        title={
          <span className="flex items-center gap-2">
            <Brain className="h-6 w-6 text-primary" aria-hidden />
            Learned decision model
          </span>
        }
        purpose="Built from your own history: every signal snapshot the AI was shown on a past day, matched against what the price actually did next. The weights below are measured, not assumed."
        actions={
          <>
            <Button variant="outline" onClick={() => refit.mutate(true)} disabled={refit.isPending}>
              Refit on real trades only
            </Button>
            <Button onClick={() => refit.mutate(false)} disabled={refit.isPending}>
              <RefreshCw
                className={`mr-2 h-4 w-4 ${refit.isPending ? "animate-spin" : ""}`}
                aria-hidden
              />
              {refit.isPending ? "Fitting…" : "Refit on all history"}
            </Button>
          </>
        }
      >


        {message ? (
          <Card className="mt-4 border-primary/30">
            <CardContent className="py-3 text-sm">{message}</CardContent>
          </Card>
        ) : null}

        {isLoading ? (
          <p className="mt-8 text-sm text-muted-foreground">Loading…</p>
        ) : !model ? (
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>No model fitted yet</CardTitle>
              <CardDescription>
                Press “Refit on all history” to build the first one from your recorded decisions.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle>Does it actually work?</CardTitle>
                  <Badge variant={model.usable ? "default" : "secondary"}>
                    {model.usable ? "Edge confirmed" : "Too weak to trade on"}
                  </Badge>
                </div>
                <CardDescription>
                  Measured on {test?.dates ?? 0} days that were never used to build it.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Ranking accuracy" value={num(test?.mean_ic)} hint="0 = no skill" />
                  <Stat label="Confidence (t)" value={num(test?.ic_t_stat, 2)} hint="above 2 is solid" />
                  <Stat
                    label="Right on"
                    value={test?.ic_hit_rate == null ? "—" : `${(test.ic_hit_rate * 100).toFixed(0)}% of days`}
                  />
                  <Stat
                    label="Best minus worst pick"
                    value={pct(test?.top_bottom_spread_pct, 2)}
                    hint={`per ${model.horizon_days} days`}
                  />
                </div>
                <p className="text-muted-foreground">
                  Naive equal-weighting of the same signals scored {num(baseline?.mean_ic)} over the same
                  days, so the fitted weights add{" "}
                  {num((test?.mean_ic ?? 0) - (baseline?.mean_ic ?? 0))}.
                </p>
                <p className="text-muted-foreground">{model.note}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>What has actually paid</CardTitle>
                <CardDescription>
                  Share of the decision each signal family earns, from your results.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {Object.entries(model.bucket_weights)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <div key={k}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span>{BUCKET_LABELS[k] ?? k}</span>
                        <span className="tabular-nums text-muted-foreground">{v.toFixed(1)}%</span>
                      </div>
                      <Progress value={v} />
                    </div>
                  ))}
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Individual signals</CardTitle>
                <CardDescription>
                  A positive number means more of that signal has been followed by a better{" "}
                  {model.horizon_days}-day return than the rest of the list that day.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-2 sm:grid-cols-2">
                  {[...features]
                    .sort((a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient))
                    .map((f) => (
                      <div
                        key={f.key}
                        className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                      >
                        <span>{f.label}</span>
                        <span
                          className={`tabular-nums ${f.coefficient >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
                        >
                          {f.coefficient >= 0 ? "+" : ""}
                          {f.coefficient.toFixed(4)}
                        </span>
                      </div>
                    ))}
                </div>
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>History used</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm sm:grid-cols-4">
                <Stat label="Observations" value={String(model.coverage.samples)} />
                <Stat label="Trading days" value={String(model.coverage.dates)} />
                <Stat label="Instruments" value={String(model.coverage.symbols)} />
                <Stat
                  label="Period"
                  value={`${model.coverage.from ?? "—"} → ${model.coverage.to ?? "—"}`}
                />
              </CardContent>
            </Card>
          </div>
        )}
      </PageShell>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
