// "AI chart read": asks the model to interpret the SMA overlays and RSI
// divergence/zone markers currently on screen, on demand.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Sparkles, RefreshCw } from "lucide-react";

import { getTechnicalRead } from "@/lib/technical-read.functions";
import type { SmaPeriod } from "@/lib/market-symbol-history";
import type { RsiSignalMode } from "@/lib/rsi-signals";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  symbol: string;
  days: number;
  periods: SmaPeriod[];
  basis: SmaPeriod | null;
  signalMode: RsiSignalMode;
}

export function AiChartReadCard({ symbol, days, periods, basis, signalMode }: Props) {
  const [enabled, setEnabled] = useState(false);
  const run = useServerFn(getTechnicalRead);

  const query = useQuery({
    queryKey: ["chart-read", symbol, days, periods.join("-"), basis, signalMode],
    queryFn: () => run({ data: { symbol, days, periods, basis, signalMode } }),
    enabled,
    staleTime: 15 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const data = query.data;
  const busy = query.isLoading || query.isFetching;

  return (
    <section className="rounded-lg border border-border bg-card/60 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="size-4 text-primary" aria-hidden />
          AI read of this chart
        </h3>
        <div className="flex items-center gap-2">
          {data?.model ? (
            <Badge variant="outline" className="text-[10px]">
              {data.model}
            </Badge>
          ) : data ? (
            <Badge variant="outline" className="text-[10px]">
              rule-based
            </Badge>
          ) : null}
          <Button
            size="sm"
            variant={enabled ? "ghost" : "secondary"}
            disabled={busy}
            onClick={() => {
              if (!enabled) setEnabled(true);
              else void query.refetch();
            }}
          >
            {busy ? (
              <RefreshCw className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="size-3.5" aria-hidden />
            )}
            {enabled ? "Re-read" : "Interpret"}
          </Button>
        </div>
      </header>

      <p className="mt-1 text-xs text-muted-foreground">
        Reads the selected moving averages, crossovers, RSI level and any divergence or zone
        markers on screen — nothing else.
      </p>

      {query.isError ? (
        <p className="mt-3 text-sm text-destructive">
          {(query.error as Error)?.message ?? "Could not interpret this chart."}
        </p>
      ) : null}

      {busy && !data ? (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : null}

      {data ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm leading-relaxed">{data.read}</p>
          {data.watch.length ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {data.watch.map((w, i) => (
                <li key={i} className="flex gap-2">
                  <span aria-hidden>•</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            {data.brief.divergences.length} divergence
            {data.brief.divergences.length === 1 ? "" : "s"} and {data.brief.crossovers.length}{" "}
            crossover{data.brief.crossovers.length === 1 ? "" : "s"} in this window. Not financial
            advice.
          </p>
        </div>
      ) : null}
    </section>
  );
}
