import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getPreflightAnomaly } from "@/lib/preflight-anomaly.functions";
import { phaseLabel } from "@/lib/preflight-anomaly";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, RefreshCw, Search } from "lucide-react";
import { formatUkTime } from "@/lib/uk-time";

const SEVERITY_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ok: "outline",
  watch: "secondary",
  slow: "default",
  critical: "destructive",
};

const SEVERITY_LABEL: Record<string, string> = {
  ok: "Normal",
  watch: "Watch",
  slow: "Slow",
  critical: "Critical",
};

function secs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function PreflightAnomalyCard() {
  const fetchReport = useServerFn(getPreflightAnomaly);
  const q = useQuery({
    queryKey: ["preflight-anomaly"],
    queryFn: () => fetchReport({ data: { historyRuns: 30 } }),
    refetchInterval: 120_000,
  });

  const res = q.data;
  const report = res?.report ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4" />
          Pre-flight anomaly detector
        </CardTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
          className="gap-1"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {q.isLoading && <p className="text-muted-foreground">Analysing recent runs…</p>}
        {q.isError && (
          <p className="text-destructive">Could not analyse pre-flight timings: {(q.error as Error).message}</p>
        )}
        {res?.noData && (
          <p className="text-muted-foreground">
            No run has recorded pre-flight step timings yet. The next hourly or manual run will populate this.
          </p>
        )}

        {report && (
          <>
            <div
              className={`rounded-md border p-3 ${
                report.anomalous
                  ? "border-destructive/40 bg-destructive/10"
                  : "border-border bg-muted/40"
              }`}
            >
              <p className="font-medium">{report.headline}</p>
              <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
                <Search className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{report.recommendation}</span>
              </p>
            </div>

            <div className="text-xs text-muted-foreground">
              Latest run {res?.latestRunAt ? formatUkTime(res.latestRunAt) : "—"}
              {res?.latestTriggeredBy ? ` · ${res.latestTriggeredBy}` : ""} · pre-flight {secs(report.totalPreflightMs)} (
              {Math.round(report.preflightBudgetShare * 100)}% of budget) · baseline {report.baselineRuns} run
              {report.baselineRuns === 1 ? "" : "s"}
            </div>

            <div className="space-y-1">
              {report.phases.map((p) => (
                <div
                  key={p.phase}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/60 px-2 py-1.5"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{phaseLabel(p.phase)}</div>
                    <div className="text-xs text-muted-foreground">{p.reason}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="tabular-nums text-xs text-muted-foreground">
                      {secs(p.ms)}
                      {p.medianMs !== null ? ` vs ${secs(p.medianMs)} usual` : ""}
                    </span>
                    <Badge variant={SEVERITY_VARIANT[p.severity]}>{SEVERITY_LABEL[p.severity]}</Badge>
                  </div>
                </div>
              ))}
              {report.phases.length === 0 && (
                <p className="text-muted-foreground">
                  The latest run skipped pre-flight entirely (bounded manual run) — nothing to compare.
                </p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
