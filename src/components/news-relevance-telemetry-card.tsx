import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, AlertTriangle, CheckCircle2 } from "lucide-react";
import { getRelevanceScoringTelemetry } from "@/lib/news-relevance-telemetry.functions";
import { describeFailureReason, type RelevanceFailureReason } from "@/lib/news-relevance-telemetry";
import { POLL } from "@/lib/query-keys";

/**
 * Diagnostics strip for the Gemini relevance ranker: batch latency, batch
 * failures, and how often the deterministic scorer had to carry the run.
 */
export function NewsRelevanceTelemetryCard() {
  const read = useServerFn(getRelevanceScoringTelemetry);
  const q = useQuery({
    queryKey: ["news-relevance-telemetry"],
    queryFn: () => read({ data: { limit: 8 } }),
    refetchInterval: POLL.SEMI_LIVE,
  });

  const runs = q.data?.runs ?? [];
  if (q.isLoading || runs.length === 0) return null;

  const latest = runs[0];
  const fallbackPct = latest.items > 0 ? Math.round((latest.fallback_items / latest.items) * 100) : 0;
  const healthy = latest.batch_failures === 0 && fallbackPct === 0;

  return (
    <div className="rounded-lg border border-border bg-background/60 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Activity className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="font-medium text-foreground">AI relevance scoring</span>
        {healthy ? (
          <span className="inline-flex items-center gap-1 text-success">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> full Gemini coverage
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> deterministic fallback {fallbackPct}%
          </span>
        )}
        <span className="text-muted-foreground">
          p50 {latest.latency_ms_p50}ms · max {latest.latency_ms_max}ms · {latest.batches} batch
          {latest.batches === 1 ? "" : "es"} · {latest.batch_failures} failed
        </span>
      </div>

      {latest.fallback_reason ? (
        <p className="mt-1.5 text-muted-foreground">{latest.fallback_reason}</p>
      ) : null}

      <ul className="mt-2 space-y-1">
        {runs.map((r) => {
          const pct = r.items > 0 ? Math.round((r.fallback_items / r.items) * 100) : 0;
          const reasons = Object.entries(r.failure_reasons ?? {}) as Array<[RelevanceFailureReason, number]>;
          return (
            <li key={r.id} className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
              <span className="tabular-nums">{new Date(r.created_at).toLocaleString("en-GB")}</span>
              <span>·</span>
              <span>{r.trigger}</span>
              <span>·</span>
              <span className="tabular-nums">
                {r.llm_scored}/{r.items} scored by Gemini
              </span>
              <span>·</span>
              <span className="tabular-nums">p50 {r.latency_ms_p50}ms</span>
              {pct > 0 ? (
                <span className="text-destructive">
                  fallback {pct}%
                  {reasons.length > 0 ? ` (${reasons.map(([k, n]) => `${describeFailureReason(k)} ×${n}`).join(", ")})` : ""}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
