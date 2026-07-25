import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getTradeErrors, type TradeErrorRow } from "@/lib/trade-errors.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, Info } from "lucide-react";
import { formatUkTime } from "@/lib/uk-time";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface Props {
  portfolioId: string;
  active?: boolean;
}

/**
 * Trade Errors dashboard: every failed / rejected live order in the last 72h
 * with its root-cause code, the FX capture from that tick, and the exact
 * pre-placement affordability decision that let (or should have stopped)
 * the order.
 */
export function TradeErrorDashboardCard({ portfolioId, active = true }: Props) {
  const fetchErrors = useServerFn(getTradeErrors);
  const query = useQuery({
    queryKey: ["trade-errors", portfolioId],
    queryFn: () => fetchErrors({ data: { portfolioId, sinceHours: 72, limit: 100 } }),
    enabled: active,
    staleTime: 30_000,
  });

  const rows = query.data?.rows ?? [];

  return (
    <Card className="border-amber-500/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />
            Trade errors
            {query.data && (
              <Badge variant="outline" className="ml-1">
                {query.data.totalErrors} in {query.data.windowHours}h
              </Badge>
            )}
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            aria-label="Refresh trade errors"
          >
            <RefreshCw
              className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`}
              aria-hidden
            />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Every rejected or errored order in the last 72h, with the FX source
          and the exact pre-placement affordability decision from that tick.
        </p>
      </CardHeader>
      <CardContent>
        {query.isLoading && (
          <div className="h-32 rounded-lg border bg-muted/30" aria-hidden />
        )}
        {query.error && (
          <p className="text-sm text-destructive">
            Failed to load: {String((query.error as Error).message ?? query.error)}
          </p>
        )}
        {!query.isLoading && !query.error && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No failed trades in the last 72 hours. 🎉
          </p>
        )}
        {rows.length > 0 && (
          <TooltipProvider delayDuration={150}>
            {/* Desktop / tablet table */}
            <div className="hidden md:block overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="bg-muted/60 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="p-2 text-left">When</th>
                    <th className="p-2 text-left">Order</th>
                    <th className="p-2 text-left">Status</th>
                    <th className="p-2 text-left">Root cause</th>
                    <th className="p-2 text-left">FX</th>
                    <th className="p-2 text-left">Affordability</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t align-top">
                      <td className="p-2 whitespace-nowrap text-xs text-muted-foreground">
                        {formatUkTime(r.createdAt)}
                      </td>
                      <td className="p-2">
                        <div className="font-medium">{r.symbol}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.side} {r.quantity}
                        </div>
                      </td>
                      <td className="p-2">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="p-2">
                        <RootCauseCell row={r} />
                      </td>
                      <td className="p-2">
                        <FxCell row={r} />
                      </td>
                      <td className="p-2">
                        <AffordabilityCell row={r} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile: stacked cards */}
            <ul className="md:hidden space-y-2">
              {rows.map((r) => (
                <li key={r.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="font-medium">
                        {r.symbol} <span className="text-muted-foreground">{r.side} {r.quantity}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatUkTime(r.createdAt)}
                      </div>
                    </div>
                    <StatusBadge status={r.status} />
                  </div>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">Cause</dt>
                    <dd><RootCauseCell row={r} /></dd>
                    <dt className="text-muted-foreground">FX</dt>
                    <dd><FxCell row={r} /></dd>
                    <dt className="text-muted-foreground">Trim</dt>
                    <dd><AffordabilityCell row={r} /></dd>
                  </dl>
                </li>
              ))}
            </ul>
          </TooltipProvider>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isError = status === "error";
  return (
    <Badge
      variant={isError ? "destructive" : "outline"}
      className={isError ? "" : "border-amber-500/50 text-amber-600 dark:text-amber-400"}
    >
      {status}
    </Badge>
  );
}

function RootCauseCell({ row }: { row: TradeErrorRow }) {
  const code = row.rootCauseCode;
  const msg = row.rootCauseMessage;
  if (!code && !msg) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <div className="flex items-start gap-1">
      <div>
        {code && (
          <Badge variant="outline" className="mr-1 font-mono text-[10px]">
            {code}
          </Badge>
        )}
        {msg && (
          <span className="text-xs text-muted-foreground line-clamp-2">
            {msg}
          </span>
        )}
      </div>
      {msg && msg.length > 100 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Info className="h-3 w-3 shrink-0 text-muted-foreground mt-0.5" aria-label="Full message" />
          </TooltipTrigger>
          <TooltipContent className="max-w-sm text-xs">{msg}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function FxCell({ row }: { row: TradeErrorRow }) {
  const fx = row.fx;
  if (!fx) return <span className="text-xs text-muted-foreground">n/a</span>;
  if (!fx.from || !fx.to) {
    return <span className="text-xs text-muted-foreground">identity</span>;
  }
  const rateText = fx.rate != null ? fx.rate.toFixed(4) : "?";
  const source = fx.source ?? "unknown";
  const isBroken = fx.stale && fx.rate === 1 && source.startsWith("fallback");
  return (
    <div>
      <div className="text-xs font-mono">
        {fx.from}→{fx.to} @ {rateText}
      </div>
      <div className="text-[10px] mt-0.5 flex flex-wrap items-center gap-1">
        <Badge
          variant="outline"
          className={
            isBroken
              ? "border-destructive/60 text-destructive"
              : fx.stale
                ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
                : ""
          }
        >
          {source}
        </Badge>
        {fx.stale && <span className="text-muted-foreground">stale</span>}
      </div>
    </div>
  );
}

function AffordabilityCell({ row }: { row: TradeErrorRow }) {
  const a = row.affordability;
  if (a.kind === "no_data") {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  if (a.kind === "allowed") {
    return (
      <Badge variant="outline" className="border-emerald-500/50 text-emerald-600 dark:text-emerald-400">
        allowed
      </Badge>
    );
  }
  if (a.kind === "fx_blocked") {
    return (
      <div>
        <Badge variant="destructive">fx blocked</Badge>
        <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2">
          {a.reason}
        </p>
      </div>
    );
  }
  // skipped
  return (
    <div>
      <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-400">
        skipped
      </Badge>
      {a.notionalBrokerCcy != null && (
        <div className="text-[11px] mt-0.5 text-muted-foreground">
          notional ≈ {a.notionalBrokerCcy.toFixed(2)}
        </div>
      )}
      <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">
        {a.reason}
      </p>
    </div>
  );
}
