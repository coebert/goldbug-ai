import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getFxTradeDrilldown } from "@/lib/fx-trade-drilldown.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, Layers } from "lucide-react";
import { formatUkTime } from "@/lib/uk-time";
import { POLL } from "@/lib/query-keys";

interface Props {
  portfolioId: string;
  active?: boolean;
}

/**
 * Per-trade FX drilldown — shows, for each recent Saxo SIM tick, exactly
 * which USD/GBP↔EUR cross-rate the executor applied to fund each individual
 * cross-currency buy. Correlated by decision_id so operators can trace a
 * sizing decision back to the rate, source, and amount converted.
 */
export function FxTradeDrilldownCard({ portfolioId, active = true }: Props) {
  const fetchFn = useServerFn(getFxTradeDrilldown);
  const q = useQuery({
    queryKey: ["fx-trade-drilldown", portfolioId],
    queryFn: () => fetchFn({ data: { portfolioId, limit: 10 } }),
    enabled: active,
    staleTime: 30_000,
    refetchInterval: POLL.SEMI_LIVE,
  });
  const data = q.data;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4 text-primary" aria-hidden />
            FX drilldown — per-trade cross-rates
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            aria-label="Refresh FX drilldown"
          >
            <RefreshCw
              className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`}
              aria-hidden
            />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          For each recent tick that converted currency, the exact FX leg the
          executor applied to fund each individual buy (from → to, amount
          converted, rate, and the tick-level FX_CAPTURE that drove sizing).
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading && (
          <div className="h-24 rounded-lg border bg-muted/30" aria-hidden />
        )}
        {q.error && (
          <p className="text-sm text-destructive">
            Failed to load: {String((q.error as Error).message ?? q.error)}
          </p>
        )}
        {data && data.decisions.length === 0 && !q.isLoading && (
          <p className="text-sm text-muted-foreground">
            No cross-currency FX legs recorded on recent ticks — either the
            portfolio's base currency matches every routed instrument, or no
            ticks have run yet.
          </p>
        )}
        {data &&
          data.decisions.map((d) => (
            <div
              key={(d.decisionId ?? d.createdAt) + d.createdAt}
              className="rounded-lg border bg-card/30 p-3 space-y-2"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="font-medium">Tick</span>
                <span className="text-muted-foreground">
                  {formatUkTime(d.asOf ?? d.createdAt)}
                </span>
                {d.decisionId && (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    decision {d.decisionId.slice(0, 8)}
                  </Badge>
                )}
                {d.capture && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span className="font-mono">{d.capture.pair}</span>
                    <span className="tabular-nums">
                      {d.capture.rate != null
                        ? d.capture.rate.toFixed(6)
                        : "—"}
                    </span>
                    <Badge
                      variant="outline"
                      className={`font-mono text-[10px] ${
                        (d.capture.source ?? "").startsWith("fallback")
                          ? "border-destructive/60 text-destructive"
                          : d.capture.stale
                            ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
                            : ""
                      }`}
                    >
                      {d.capture.source ?? "unknown"}
                    </Badge>
                  </>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="py-1 pr-2">Symbol</th>
                      <th className="py-1 pr-2">Pair</th>
                      <th className="py-1 pr-2 text-right">Amount from</th>
                      <th className="py-1 pr-2 text-right">Amount to</th>
                      <th className="py-1 pr-2 text-right">Rate applied</th>
                      <th className="py-1">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.legs.map((leg, i) => (
                      <tr
                        key={`${leg.triggeredBySymbol ?? "?"}:${i}`}
                        className="border-b last:border-b-0"
                      >
                        <td className="py-1.5 pr-2 font-mono">
                          {leg.triggeredBySymbol ?? "—"}
                        </td>
                        <td className="py-1.5 pr-2 font-mono">
                          {leg.fromCcy ?? "?"}→{leg.toCcy ?? "?"}
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">
                          {leg.amountFrom != null
                            ? leg.amountFrom.toFixed(2)
                            : "—"}
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">
                          {leg.amountTo != null
                            ? leg.amountTo.toFixed(2)
                            : "—"}
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">
                          {leg.rate != null ? leg.rate.toFixed(6) : "—"}
                        </td>
                        <td className="py-1.5">
                          {leg.stale ? (
                            <Badge
                              variant="outline"
                              className="border-amber-500/50 text-amber-600 dark:text-amber-400 text-[10px]"
                            >
                              stale
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px]">
                              fresh
                            </Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
