import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getFxAudit } from "@/lib/fx-audit.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, ScrollText } from "lucide-react";
import { formatUkTime } from "@/lib/uk-time";
import { POLL } from "@/lib/query-keys";

interface Props {
  portfolioId: string;
  active?: boolean;
}

/**
 * Saxo SIM run FX audit — shows the exact provider, fetch/observation
 * timestamp, and computed cross-rates (USD/GBP↔EUR) the sizer would use
 * for the next tick. Also surfaces the most recent FX_CAPTURE recorded
 * for this portfolio so the operator can prove parity with what actually
 * ran.
 */
export function FxAuditCard({ portfolioId, active = true }: Props) {
  const fetchAudit = useServerFn(getFxAudit);
  const q = useQuery({
    queryKey: ["fx-audit", portfolioId],
    queryFn: () => fetchAudit({ data: { portfolioId } }),
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
            <ScrollText className="h-4 w-4 text-primary" aria-hidden />
            FX audit — sizing cross-rates
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            aria-label="Refresh FX audit"
          >
            <RefreshCw
              className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`}
              aria-hidden
            />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Exact provider, observation timestamp, and USD/GBP↔EUR rates the
          sizer would apply on the next Saxo SIM tick. "cache" means the
          value was resolved from an in-process cache written at the shown
          time. "fallback:*" means both live providers failed and cross-currency
          buys are blocked.
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
        {data && (
          <>
            <div className="text-[11px] text-muted-foreground">
              Snapshot taken {formatUkTime(data.requestedAt)}
              {data.base ? (
                <>
                  {" · portfolio base "}
                  <span className="font-mono">{data.base}</span>
                </>
              ) : null}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="py-1 pr-2">Pair</th>
                    <th className="py-1 pr-2 text-right">Rate</th>
                    <th className="py-1 pr-2 text-right">1 / rate</th>
                    <th className="py-1 pr-2">Source</th>
                    <th className="py-1">Observed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pairs.map((p) => {
                    const isBaseRow =
                      data.base != null &&
                      (p.from === data.base || p.to === data.base);
                    const bad = p.source.startsWith("fallback");
                    const warn = p.stale || p.source === "cache-stale";
                    return (
                      <tr
                        key={`${p.from}${p.to}`}
                        className={`border-b last:border-b-0 ${
                          isBaseRow ? "bg-muted/30" : ""
                        }`}
                      >
                        <td className="py-1.5 pr-2 font-mono">
                          {p.from}→{p.to}
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">
                          {p.rate.toFixed(6)}
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                          {p.impliedInverse.toFixed(6)}
                        </td>
                        <td className="py-1.5 pr-2">
                          <Badge
                            variant="outline"
                            className={
                              bad
                                ? "border-destructive/60 text-destructive font-mono text-[10px]"
                                : warn
                                  ? "border-amber-500/50 text-amber-600 dark:text-amber-400 font-mono text-[10px]"
                                  : "font-mono text-[10px]"
                            }
                            title={p.source}
                          >
                            {p.source.length > 22
                              ? p.source.slice(0, 22) + "…"
                              : p.source}
                          </Badge>
                        </td>
                        <td className="py-1.5 text-[11px] whitespace-nowrap">
                          {formatUkTime(p.observedAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="rounded-lg border bg-muted/20 p-3 text-xs">
              <div className="font-medium mb-1">
                Last FX_CAPTURE recorded for this portfolio
              </div>
              {data.lastCapture ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono">{data.lastCapture.pair}</span>
                  <span className="tabular-nums">
                    rate{" "}
                    {data.lastCapture.rate != null
                      ? data.lastCapture.rate.toFixed(6)
                      : "—"}
                  </span>
                  <Badge
                    variant="outline"
                    className={`font-mono text-[10px] ${
                      (data.lastCapture.source ?? "").startsWith("fallback")
                        ? "border-destructive/60 text-destructive"
                        : data.lastCapture.stale
                          ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
                          : ""
                    }`}
                  >
                    {data.lastCapture.source ?? "unknown"}
                  </Badge>
                  {data.lastCapture.env && (
                    <Badge variant="outline" className="text-[10px]">
                      env: {data.lastCapture.env}
                    </Badge>
                  )}
                  <span className="text-muted-foreground">
                    {formatUkTime(data.lastCapture.createdAt)}
                  </span>
                </div>
              ) : (
                <span className="text-muted-foreground">
                  No FX_CAPTURE row yet — either the portfolio hasn't run or
                  its base matches the broker account currency.
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
