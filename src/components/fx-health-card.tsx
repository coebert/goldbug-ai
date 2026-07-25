import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getFxHealth } from "@/lib/fx-health.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, RefreshCw } from "lucide-react";
import { formatUkTime } from "@/lib/uk-time";

interface Props {
  portfolioId: string;
  active?: boolean;
}

/**
 * FX provider health for a portfolio. Reads the last 24h of FX_CAPTURE logs
 * and shows per-pair status plus provider hit counts so the operator can
 * see at a glance whether Yahoo / Frankfurter are healthy or whether the
 * app is coasting on cache / identity fallbacks.
 */
export function FxHealthCard({ portfolioId, active = true }: Props) {
  const fetchHealth = useServerFn(getFxHealth);
  const query = useQuery({
    queryKey: ["fx-health", portfolioId],
    queryFn: () => fetchHealth({ data: { portfolioId, sinceHours: 24 } }),
    enabled: active,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const data = query.data;
  const overall = data?.overall ?? "ok";

  return (
    <Card
      className={
        overall === "critical"
          ? "border-destructive/40"
          : overall === "degraded"
            ? "border-amber-500/40"
            : "border-emerald-500/30"
      }
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity
              className={`h-4 w-4 ${
                overall === "critical"
                  ? "text-destructive"
                  : overall === "degraded"
                    ? "text-amber-500"
                    : "text-emerald-500"
              }`}
              aria-hidden
            />
            FX endpoint health
            <StatusPill status={overall} />
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            aria-label="Refresh FX health"
          >
            <RefreshCw
              className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`}
              aria-hidden
            />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Yahoo / Frankfurter success rate over the last {data?.windowHours ?? 24}h.
          Identity fallback (rate 1.0000) means both providers failed and
          cross-currency buys are being blocked.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading && (
          <div className="h-20 rounded-lg border bg-muted/30" aria-hidden />
        )}
        {query.error && (
          <p className="text-sm text-destructive">
            Failed to load: {String((query.error as Error).message ?? query.error)}
          </p>
        )}
        {data && data.pairs.length === 0 && !query.isLoading && (
          <p className="text-sm text-muted-foreground">
            No cross-currency FX activity in the window — nothing to monitor.
          </p>
        )}
        {data && data.pairs.length > 0 && (
          <>
            {overall !== "ok" && (
              <div
                role="alert"
                className={`rounded-lg border p-3 text-sm ${
                  overall === "critical"
                    ? "border-destructive/40 bg-destructive/5 text-destructive"
                    : "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400"
                }`}
              >
                {overall === "critical"
                  ? "FX providers are currently DOWN. Cross-currency buys will be refused. An in-app notification has been sent."
                  : "FX providers are degraded — some captures fell back to cache or stale rates. Trades continue with a wider safety buffer."}
              </div>
            )}
            <ul className="space-y-2">
              {data.pairs.map((p) => (
                <li key={p.pair} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium">{p.pair}</span>
                      <StatusPill status={p.status} />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      last: {p.lastRate != null ? p.lastRate.toFixed(4) : "?"}{" "}
                      <Badge variant="outline" className="ml-1 font-mono text-[10px]">
                        {p.lastSource}
                      </Badge>
                      {p.lastAt && (
                        <span className="ml-2">{formatUkTime(p.lastAt)}</span>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                    <ProviderChip label="yahoo" n={p.counts.yahoo} good />
                    <ProviderChip label="frankfurter" n={p.counts.frankfurter} good />
                    <ProviderChip label="cache" n={p.counts.cache} />
                    {p.counts["cache-stale"] > 0 && (
                      <ProviderChip label="cache-stale" n={p.counts["cache-stale"]} warn />
                    )}
                    {p.counts.fallback > 0 && (
                      <ProviderChip label="identity fallback" n={p.counts.fallback} bad />
                    )}
                  </div>
                  {p.lastError && (
                    <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2">
                      {p.lastError}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StatusPill({ status }: { status: "ok" | "degraded" | "critical" }) {
  if (status === "critical")
    return <Badge variant="destructive">critical</Badge>;
  if (status === "degraded")
    return (
      <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-400">
        degraded
      </Badge>
    );
  return (
    <Badge variant="outline" className="border-emerald-500/50 text-emerald-600 dark:text-emerald-400">
      healthy
    </Badge>
  );
}

function ProviderChip({
  label,
  n,
  good,
  warn,
  bad,
}: {
  label: string;
  n: number;
  good?: boolean;
  warn?: boolean;
  bad?: boolean;
}) {
  const cls = bad
    ? "border-destructive/60 text-destructive"
    : warn
      ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
      : good && n > 0
        ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
        : "";
  return (
    <Badge variant="outline" className={cls}>
      {label}: {n}
    </Badge>
  );
}
