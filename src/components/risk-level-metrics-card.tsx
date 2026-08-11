import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, ShieldCheck, Gauge } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getRiskLevelPanel } from "@/lib/risk-level-panel.functions";
import type { RiskLevelMetrics } from "@/lib/risk-level-panel";
import { formatUk } from "@/lib/uk-time";

/**
 * Quick-verification panel: one row per risk level with its risk metrics,
 * drawdown and diversification, plus ladder sanity warnings (e.g. low risk
 * drawing down harder than high risk, or two levels looking identical).
 */

const LABELS: Record<string, string> = {
  low: "Low risk",
  balanced: "Balanced",
  high: "High risk",
  unknown: "Unclassified",
};

function pct(n: number, digits = 1) {
  return `${n >= 0 ? "" : ""}${n.toFixed(digits)}%`;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={`truncate text-sm font-semibold tabular-nums ${
          tone === "pos" ? "text-primary" : tone === "neg" ? "text-destructive" : "text-foreground"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Row({ row, currency }: { row: RiskLevelMetrics; currency: string }) {
  const money = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency || "GBP",
    maximumFractionDigits: 0,
  });
  const thin = row.observations < 3;
  const mixedCurrency = row.currencies.length > 1;

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{LABELS[row.riskLevel] ?? row.riskLevel}</span>
        <Badge variant="secondary" className="text-[11px]">
          {row.portfolioCount} {row.portfolioCount === 1 ? "portfolio" : "portfolios"}
        </Badge>
        <span className="text-xs text-muted-foreground">{money.format(row.totalEquity)}</span>
        {thin && (
          <Badge variant="outline" className="text-[11px]">
            Not enough history
          </Badge>
        )}
        {mixedCurrency && (
          <Badge variant="outline" className="text-[11px]">
            {row.currencies.join(" + ")} → {currency || "GBP"}
          </Badge>
        )}
        {!row.fxComplete && (
          <Badge variant="destructive" className="text-[11px]">
            FX rate unavailable
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <Metric
          label="Return"
          value={pct(row.returnPct, 2)}
          tone={row.returnPct >= 0 ? "pos" : "neg"}
        />
        <Metric label="Max drawdown" value={pct(row.maxDrawdownPct, 2)} tone="neg" />
        <Metric label="Volatility" value={pct(row.annualisedVolPct, 1)} />
        <Metric label="Sharpe" value={row.sharpe.toFixed(2)} />
        <Metric label="Positions" value={String(row.positions)} />
        <Metric
          label="Top weight"
          value={row.topSymbol ? `${row.topWeightPct.toFixed(0)}% ${row.topSymbol}` : "—"}
        />
        <Metric label="Cash" value={pct(row.cashPct, 0)} />
      </div>

      <div className="mt-2 text-[11px] text-muted-foreground">
        Effective names {row.effectiveNames.toFixed(1)} · concentration{" "}
        {row.concentrationHhi.toFixed(2)}
        {row.drawdownTroughDate ? ` · worst on ${row.drawdownTroughDate}` : ""}
        {row.flowEvents > 0
          ? ` · ${row.flowEvents} deposit/withdrawal ${
              row.flowEvents === 1 ? "step" : "steps"
            } netted out (${money.format(row.netExternalFlow)})`
          : ""}
      </div>
    </div>
  );
}

export function RiskLevelMetricsCard() {
  const fetchPanel = useServerFn(getRiskLevelPanel);
  const q = useQuery({
    queryKey: ["risk-level-panel"],
    queryFn: () => fetchPanel(),
    staleTime: 60_000,
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="h-4 w-4 text-primary" />
          Risk levels at a glance
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Return, drawdown and volatility exclude deposits, withdrawals and cash re-syncs; all
          figures converted to {q.data?.currency ?? "GBP"}. Per risk level
          {q.data ? ` · last ${q.data.lookbackDays} days · ${formatUk(q.data.computedAt)}` : ""}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isLoading && <Skeleton className="h-28 w-full" />}
        {q.isError && (
          <p className="text-sm text-destructive">
            Couldn’t load risk-level metrics. Try refreshing.
          </p>
        )}
        {q.data && q.data.rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No active portfolios to compare yet.</p>
        )}

        {q.data?.rows.map((row) => (
          <Row key={row.riskLevel} row={row} currency={q.data.currency} />
        ))}

        {q.data && q.data.rows.length > 0 && (
          <div className="space-y-1.5 pt-1">
            {q.data.warnings.length === 0 ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                Risk ladder looks consistent — higher risk carries more volatility and deeper
                drawdowns.
              </p>
            ) : (
              q.data.warnings.map((w, i) => (
                <p
                  key={`${w.kind}-${i}`}
                  className="flex items-start gap-2 text-xs text-destructive"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{w.message}</span>
                </p>
              ))
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
