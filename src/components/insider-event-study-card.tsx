import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { runInsiderStudy } from "@/lib/backtest/insider-event-study.functions";
import type { StudyResult } from "@/lib/backtest/insider-event-study.server";
import type { Bucket, HorizonStats } from "@/lib/backtest/insider-event-study";

const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;

function tone(s: HorizonStats): string {
  if (!s.significant) return "text-muted-foreground";
  return s.mean_abn < 0 ? "text-destructive" : "text-primary";
}

function BucketTable({ bucket }: { bucket: Bucket }) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{bucket.label}</span>
        <Badge variant="outline">n={bucket.n}</Badge>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 text-left font-normal">Horizon</th>
              <th className="py-1 pr-3 text-right font-normal">Raw</th>
              <th className="py-1 pr-3 text-right font-normal">vs index</th>
              <th className="py-1 pr-3 text-right font-normal">Median</th>
              <th className="py-1 pr-3 text-right font-normal">Hit</th>
              <th className="py-1 text-right font-normal">95% CI</th>
            </tr>
          </thead>
          <tbody>
            {bucket.stats.map((s) => (
              <tr key={s.horizon} className="border-t border-border/40">
                <td className="py-1 pr-3">+{s.horizon}d</td>
                <td className="py-1 pr-3 text-right">{pct(s.mean_ret)}</td>
                <td className={`py-1 pr-3 text-right font-medium ${tone(s)}`}>{pct(s.mean_abn)}</td>
                <td className="py-1 pr-3 text-right">{pct(s.median_abn)}</td>
                <td className="py-1 pr-3 text-right">{Math.round(s.hit_rate * 100)}%</td>
                <td className="py-1 text-right text-muted-foreground">
                  {Number.isFinite(s.ci_lo) ? `${s.ci_lo} .. ${s.ci_hi}` : "—"}
                  {s.significant ? " *" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Evidence card: what actually happened to the share price after directors
 * dealt, for a held name and its peer group.
 */
export function InsiderEventStudyCard({
  symbols,
  className,
}: {
  symbols?: string[];
  className?: string;
}) {
  const run = useServerFn(runInsiderStudy);
  const [minValue, setMinValue] = useState(250_000);
  const [lookbackDays, setLookbackDays] = useState(900);
  const [result, setResult] = useState<StudyResult | null>(null);

  const m = useMutation({
    mutationFn: () => run({ data: { symbols, minValue, lookbackDays } }),
    onSuccess: (r) => setResult(r as StudyResult),
  });

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">Director-dealing event study</CardTitle>
        <CardDescription>
          Forward returns after filed director / PDMR dealings, measured against the local index.
          Same-day filings are collapsed so one board decision counts once.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="ies-min" className="text-xs">
              Min deal size
            </Label>
            <Input
              id="ies-min"
              type="number"
              className="h-9 w-32"
              value={minValue}
              min={0}
              step={50_000}
              onChange={(e) => setMinValue(Math.max(0, Number(e.target.value) || 0))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ies-days" className="text-xs">
              Lookback (days)
            </Label>
            <Input
              id="ies-days"
              type="number"
              className="h-9 w-28"
              value={lookbackDays}
              min={180}
              max={2000}
              step={90}
              onChange={(e) =>
                setLookbackDays(Math.min(2000, Math.max(180, Number(e.target.value) || 900)))
              }
            />
          </div>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>
            {m.isPending ? "Running…" : "Run study"}
          </Button>
        </div>

        {m.isError && (
          <p className="text-sm text-destructive">
            Study failed: {(m.error as Error)?.message ?? "unknown error"}
          </p>
        )}

        {result && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    result.verdict.verdict === "sells_predict_underperformance"
                      ? "destructive"
                      : "secondary"
                  }
                >
                  {result.verdict.verdict.replaceAll("_", " ")}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {result.events_used} of {result.events_seen} filings usable · {result.from} →{" "}
                  {result.to}
                </span>
              </div>
              <p className="text-muted-foreground">{result.verdict.detail}</p>
              {result.verdict.supported_nudge != null && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Evidence supports a sentiment nudge of{" "}
                  <span className="font-medium text-foreground">
                    {result.verdict.supported_nudge.toFixed(3)}
                  </span>{" "}
                  on a detected disposal.
                </p>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {result.study.buckets.map((b) => (
                <BucketTable key={b.key} bucket={b} />
              ))}
            </div>

            {result.focus && (
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {result.focus.symbol} alone ({result.focus.n} events)
                </p>
                <div className="grid gap-3 md:grid-cols-2">
                  {result.focus.study.buckets.map((b) => (
                    <BucketTable key={`focus-${b.key}`} bucket={b} />
                  ))}
                </div>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              * = 95% bootstrap interval on the index-relative return excludes zero. Small samples
              are common here; treat anything under ~30 events as anecdote.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
