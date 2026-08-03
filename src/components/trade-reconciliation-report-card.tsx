import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Clock,
  GitCompareArrows,
  ShieldAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getTradeReconciliationReport } from "@/lib/trade-reconciliation.functions";
import type { ReconOutcome } from "@/lib/trade-reconciliation";
import { formatMoney } from "@/lib/format-money";

const OUTCOME_LABEL: Record<ReconOutcome, string> = {
  filled: "Filled",
  partial: "Partial fill",
  rejected_suitability: "Suitability refused",
  rejected_broker: "Broker rejected",
  blocked_pre_trade: "Blocked before routing",
  vetoed_by_engine: "Guardrail veto",
  pending: "Awaiting broker",
  not_routed: "Never routed",
};

const OUTCOME_TONE: Record<ReconOutcome, string> = {
  filled: "border-primary/40 text-primary",
  partial: "border-primary/30 text-primary",
  rejected_suitability: "border-destructive/50 text-destructive",
  rejected_broker: "border-destructive/40 text-destructive",
  blocked_pre_trade: "border-destructive/40 text-destructive",
  vetoed_by_engine: "border-border text-muted-foreground",
  pending: "border-border text-muted-foreground",
  not_routed: "border-border text-muted-foreground",
};

function OutcomeIcon({ outcome }: { outcome: ReconOutcome }) {
  if (outcome === "filled" || outcome === "partial")
    return <CheckCircle2 className="h-4 w-4 text-primary" />;
  if (outcome === "rejected_suitability" || outcome === "blocked_pre_trade")
    return <ShieldAlert className="h-4 w-4 text-destructive" />;
  if (outcome === "rejected_broker")
    return <AlertTriangle className="h-4 w-4 text-destructive" />;
  if (outcome === "pending") return <Clock className="h-4 w-4 text-muted-foreground" />;
  return <CircleSlash className="h-4 w-4 text-muted-foreground" />;
}

export function TradeReconciliationReportCard({
  portfolioId,
  days = 14,
  currency = "GBP",
}: {
  portfolioId?: string;
  days?: number;
  currency?: string;
}) {
  const load = useServerFn(getTradeReconciliationReport);
  const q = useQuery({
    queryKey: ["trade-reconciliation", portfolioId ?? "all", days],
    queryFn: () => load({ data: { portfolioId, days } }),
  });

  const report = q.data;
  const rows = report?.rows ?? [];
  const s = report?.summary;

  return (
    <Card>
      <CardHeader className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <CardTitle className="flex min-w-0 items-center gap-2 text-base">
          <GitCompareArrows className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 break-words">Planned vs actual reconciliation</span>
        </CardTitle>
        <Badge variant="outline" className="w-fit shrink-0">
          last {days}d
        </Badge>
      </CardHeader>

      <CardContent className="space-y-4">
        {q.isLoading && (
          <p className="text-sm text-muted-foreground">Reconciling planned trades…</p>
        )}
        {q.error && (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Could not build the reconciliation report.
          </p>
        )}

        {s && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Attempts", value: String(s.attempts) },
              { label: "Filled", value: `${s.filled + s.partial}` },
              {
                label: "Broker refused",
                value: String(s.suitabilityRejected + s.otherBrokerRejected + s.blockedPreTrade),
              },
              {
                label: "Unexecuted",
                value: formatMoney(s.unexecutedValue, currency),
              },
            ].map((k) => (
              <div
                key={k.label}
                className="flex min-w-0 items-baseline justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:block"
              >
                <p className="shrink-0 text-xs text-muted-foreground sm:shrink">{k.label}</p>
                <p className="min-w-0 break-words text-right text-lg font-semibold tabular-nums text-foreground sm:text-left">
                  {k.value}
                </p>
              </div>
            ))}
          </div>
        )}

        {report && report.suitability.length > 0 && (
          <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
              <ShieldAlert className="h-4 w-4" />
              Suitability blocks cost {formatMoney(s?.suitabilityBlockedValue ?? 0, currency)} of
              planned trades
            </p>
            {report.suitability.map((g) => (
              <div key={g.symbolKey} className="text-sm">
                <p className="break-all font-mono font-semibold text-foreground">
                  {g.symbol}{" "}
                  <span className="font-sans text-xs font-normal text-muted-foreground">
                    {g.attempts} attempt{g.attempts === 1 ? "" : "s"} ·{" "}
                    {formatMoney(g.blockedValue, currency)} · {g.firstSeen} → {g.lastSeen}
                    {g.stillBlocked ? " · still blocked" : " · block cleared"}
                  </span>
                </p>
                {g.brokerText && (
                  <p className="mt-1 text-xs italic text-muted-foreground">“{g.brokerText}”</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  Next step: {g.recommendedAction}
                </p>
              </div>
            ))}
            <Link
              to="/broker-blocks"
              className="inline-block text-xs font-medium text-primary hover:underline"
            >
              Manage blocked instruments →
            </Link>
          </div>
        )}

        {!q.isLoading && !q.error && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No planned trades in this window to reconcile.
          </p>
        )}

        <div className="space-y-2">
          {rows.slice(0, 40).map((r, i) => (
            <div
              key={`${r.decisionId}-${r.symbol}-${r.side}-${i}`}
              className="min-w-0 rounded-lg border border-border bg-muted/30 p-3"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <OutcomeIcon outcome={r.outcome} />
                <span className="min-w-0 break-all font-mono text-sm font-semibold text-foreground">
                  {r.symbol}
                </span>
                <Badge variant="outline" className="uppercase">
                  {r.side}
                </Badge>
                <Badge variant="outline" className={OUTCOME_TONE[r.outcome]}>
                  {OUTCOME_LABEL[r.outcome]}
                </Badge>
                <span className="w-full text-xs tabular-nums text-muted-foreground sm:ml-auto sm:w-auto">
                  {r.runDate}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Planned {r.plannedQuantity}
                {r.plannedValue != null ? ` (${formatMoney(r.plannedValue, currency)})` : ""} ·
                filled {r.filledQuantity}
                {r.brokerStatus ? ` · broker: ${r.brokerStatus}` : " · no broker order"}
              </p>
              <p className="mt-1 text-sm text-foreground">{r.explanation}</p>
              {r.recommendedAction && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Next step: {r.recommendedAction}
                </p>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
