import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getStrategyPerformance } from "@/lib/strategy-performance.functions";
import { AxisFramedSparkline } from "@/components/charts/axis-framed-sparkline";
import { formatMoney, formatMoneySigned } from "@/lib/format-money";
import { formatUkAxisDay } from "@/lib/uk-time";

function pct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(digits)}%`;
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "bad" | null;
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={`text-lg font-semibold tabular-nums ${
          tone === "good" ? "text-emerald-500" : tone === "bad" ? "text-rose-400" : ""
        }`}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function StrategyPerformanceCard({ portfolioId }: { portfolioId: string }) {
  const fn = useServerFn(getStrategyPerformance);
  const q = useQuery({
    queryKey: ["strategy-performance", portfolioId],
    queryFn: () => fn({ data: { portfolioId } }),
    staleTime: 60_000,
  });
  const d = q.data;

  return (
    <Card data-testid="strategy-performance-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4" />
          Strategy performance
          {d?.from && d?.to && (
            <Badge variant="secondary" className="text-[10px]">
              {d.from} → {d.to}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading && <p className="text-sm text-muted-foreground">Loading equity history…</p>}
        {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
        {d && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              <Metric
                label="Annualised return"
                value={d.annualisedReturnPct == null ? pct(d.totalReturnPct) : pct(d.annualisedReturnPct)}
                hint={d.annualisedReturnPct == null ? "total so far (window under a month)" : "CAGR, flows netted out"}
                tone={(d.annualisedReturnPct ?? d.totalReturnPct) >= 0 ? "good" : "bad"}
              />
              <Metric
                label="Total return"
                value={pct(d.totalReturnPct)}
                hint={`${formatMoneySigned(d.pnl, d.currency)} on ${formatMoney(d.startEquity, d.currency)}`}
                tone={d.pnl >= 0 ? "good" : "bad"}
              />
              <Metric
                label="Sharpe"
                value={Number.isFinite(d.sharpe) ? d.sharpe.toFixed(2) : "—"}
                hint={`vol ${d.volAnnPct.toFixed(1)}% a year`}
                tone={d.sharpe >= 1 ? "good" : d.sharpe < 0 ? "bad" : null}
              />
              <Metric
                label="Sortino"
                value={d.sortino == null ? "—" : d.sortino.toFixed(2)}
                hint="downside risk only"
              />
              <Metric
                label="Max drawdown"
                value={pct(d.maxDrawdownPct)}
                hint={
                  d.maxDrawdownPeakDate
                    ? `${d.maxDrawdownPeakDate} → ${d.maxDrawdownTroughDate}`
                    : "no drawdown recorded"
                }
                tone={d.maxDrawdownPct < -10 ? "bad" : null}
              />
              <Metric
                label="Now vs high"
                value={pct(d.currentDrawdownPct)}
                hint={d.currentDrawdownPct === 0 ? "at a new high" : "below the running peak"}
                tone={d.currentDrawdownPct < 0 ? "bad" : "good"}
              />
              <Metric
                label="Up days"
                value={d.upDayPct == null ? "—" : `${d.upDayPct.toFixed(0)}%`}
                hint={`best ${pct(d.bestDayPct)} · worst ${pct(d.worstDayPct)}`}
              />
              <Metric
                label="Broker fees"
                value={formatMoney(d.fees, d.currency)}
                hint={`${d.feesBps.toFixed(0)} bps of starting equity`}
              />
            </div>

            {d.curve.length >= 2 && (
              <AxisFramedSparkline
                values={d.curve.map((p) => p.value)}
                formatValue={(n) => formatMoney(n, d.currency)}
                xStart={formatUkAxisDay(d.curve[0]!.date)}
                xEnd={formatUkAxisDay(d.curve[d.curve.length - 1]!.date)}
                xUnit="daily"
                valueAxisLabel="Equity, flows netted"
                label="Flow-adjusted equity curve"
              />
            )}

            {d.drawdowns.length > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-medium">Worst drawdowns</h3>
                <ul className="space-y-1 text-xs">
                  {d.drawdowns.slice(0, 5).map((dd) => (
                    <li
                      key={`${dd.peakDate}-${dd.troughDate}`}
                      className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border px-2 py-1.5"
                    >
                      <span className="tabular-nums text-muted-foreground">
                        {dd.peakDate} → {dd.troughDate}
                        {dd.recoveryDate ? ` → recovered ${dd.recoveryDate}` : " · not recovered"}
                      </span>
                      <span className="tabular-nums font-medium text-rose-400">
                        {pct(dd.depthPct)}
                        <span className="ml-1 text-muted-foreground">
                          {dd.daysToTrough}d down
                          {dd.daysToRecover != null ? `, ${dd.daysToRecover}d back` : ""}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {d.flowCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {d.flowCount} deposit/withdrawal{d.flowCount === 1 ? "" : "s"} totalling{" "}
                {formatMoneySigned(d.flowsNetted, d.currency)} were netted out, so none of the
                return above is your own money arriving.
              </p>
            )}
            {d.note && <p className="text-xs text-amber-400">{d.note}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
