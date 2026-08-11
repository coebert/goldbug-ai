import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Receipt } from "lucide-react";
import { getFrictionReport } from "@/lib/friction-kpi.functions";
import { formatMoney } from "@/lib/format-money";
import { POLL } from "@/lib/query-keys";
import {
  SAXO_AXIS,
  SAXO_COLOR,
  SAXO_GRID,
  SAXO_REFERENCE_LINE,
  SAXO_TOOLTIP_CONTENT,
  SAXO_TOOLTIP_CURSOR,
  SAXO_TOOLTIP_LABEL,
} from "@/lib/saxo-chart";

function bps(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}bps`;
}

function signedBps(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}bps`;
}

function VerdictBadge({ verdict }: { verdict: string }) {
  if (verdict === "improved") {
    return (
      <Badge variant="outline" className="border-emerald-500/40 text-emerald-400">
        Costs down
      </Badge>
    );
  }
  if (verdict === "worse") {
    return (
      <Badge variant="outline" className="border-rose-500/40 text-rose-400">
        Costs up
      </Badge>
    );
  }
  if (verdict === "unchanged") return <Badge variant="outline">No change yet</Badge>;
  return <Badge variant="outline">Too few trades</Badge>;
}

/**
 * The number that decides whether the live account makes money: what trading
 * actually cost over the trailing window, measured against the 40bps budget.
 * Underneath, a before/after read on the cost-control changes.
 */
export function FrictionKpiCard({
  portfolioId,
  currency = "GBP",
  enabled = true,
}: {
  portfolioId: string;
  currency?: string;
  enabled?: boolean;
}) {
  const fetchReport = useServerFn(getFrictionReport);
  const q = useQuery({
    queryKey: ["friction-report", portfolioId, currency],
    queryFn: () => fetchReport({ data: { portfolioId, currency } }),
    enabled,
    refetchInterval: POLL.SLOW,
    staleTime: 60 * 1000,
  });

  const report = q.data;
  const kpi = report?.kpi;

  const chartRows = useMemo(() => {
    if (!kpi) return [];
    return kpi.daily.map((d) => ({
      date: d.date.slice(5),
      cumulativeBps: Number(d.cumulativeBps.toFixed(2)),
    }));
  }, [kpi]);

  const headline = useMemo(() => {
    if (!kpi) return null;
    if (kpi.frictionBps == null) {
      return "No valuation to measure costs against yet.";
    }
    if (kpi.tickets === 0) {
      return `No trades in the last ${kpi.windowDays} days, so nothing was spent on costs.`;
    }
    if (kpi.breach) {
      return `Trading costs are over budget: ${bps(kpi.frictionBps)} of value spent against a ${bps(kpi.budgetBps, 0)} limit.`;
    }
    return `Trading costs are inside budget: ${bps(kpi.frictionBps)} of ${bps(kpi.budgetBps, 0)} used.`;
  }, [kpi]);

  const barColor = kpi?.breach ? SAXO_COLOR.down : SAXO_COLOR.up;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Receipt className="h-4 w-4 text-muted-foreground" aria-hidden />
          What trading is costing you
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading && <p className="text-sm text-muted-foreground">Adding up the last 30 days…</p>}
        {q.isError && (
          <p className="text-sm text-muted-foreground">Costs are unavailable right now.</p>
        )}

        {kpi && (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p
                  className={`text-3xl font-semibold tabular-nums ${kpi.breach ? "text-rose-400" : "text-emerald-400"}`}
                >
                  {bps(kpi.frictionBps)}
                </p>
                <p className="text-xs text-muted-foreground">
                  of your money, last {kpi.windowDays} days · budget {bps(kpi.budgetBps, 0)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm tabular-nums">
                  {formatMoney(kpi.frictionBase, report?.currency ?? currency, 2)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {kpi.tickets} trade{kpi.tickets === 1 ? "" : "s"} ·{" "}
                  {formatMoney(kpi.avgTicketBase, report?.currency ?? currency, 0)} average
                </p>
              </div>
            </div>

            <p className="text-sm text-muted-foreground">{headline}</p>

            {chartRows.length > 0 && (
              <div className="h-40 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid {...SAXO_GRID} />
                    <XAxis dataKey="date" {...SAXO_AXIS} minTickGap={24} />
                    <YAxis
                      {...SAXO_AXIS}
                      width={46}
                      tickFormatter={(v: number) => `${v}bps`}
                    />
                    <Tooltip
                      contentStyle={SAXO_TOOLTIP_CONTENT}
                      labelStyle={SAXO_TOOLTIP_LABEL}
                      cursor={SAXO_TOOLTIP_CURSOR}
                      formatter={(v: number) => [`${v}bps`, "Cost so far"]}
                    />
                    <ReferenceLine
                      {...SAXO_REFERENCE_LINE}
                      y={kpi.budgetBps}
                      label={{
                        value: `${kpi.budgetBps}bps budget`,
                        position: "insideTopRight",
                        fill: SAXO_COLOR.axis,
                        fontSize: 11,
                      }}
                    />
                    <Bar dataKey="cumulativeBps" fill={barColor} radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            <dl className="grid grid-cols-3 gap-3 text-xs">
              <div>
                <dt className="text-muted-foreground">Broker charges</dt>
                <dd className="tabular-nums">
                  {formatMoney(kpi.components.commissionBase, report?.currency ?? currency, 2)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Buy/sell gap</dt>
                <dd className="tabular-nums">
                  {formatMoney(kpi.components.spreadBase, report?.currency ?? currency, 2)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Stamp duty & levies</dt>
                <dd className="tabular-nums">
                  {formatMoney(kpi.components.taxBase, report?.currency ?? currency, 2)}
                </dd>
              </div>
            </dl>

            {kpi.annualisedDragPct != null && (
              <p className="text-xs text-muted-foreground">
                At this pace, costs would take {kpi.annualisedDragPct.toFixed(1)}% of the pot over a
                year.
              </p>
            )}
          </>
        )}

        {report?.attribution && (
          <div className="rounded-md border border-border/60 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-medium">Before vs after the cost controls</p>
              <VerdictBadge verdict={report.attribution.verdict} />
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div />
              <div className="text-muted-foreground">Before</div>
              <div className="text-muted-foreground">After</div>

              <div className="text-muted-foreground">Cost per 30 days</div>
              <div className="tabular-nums">{bps(report.attribution.before.frictionBpsPer30d)}</div>
              <div className="tabular-nums">{bps(report.attribution.after.frictionBpsPer30d)}</div>

              <div className="text-muted-foreground">Trades per day</div>
              <div className="tabular-nums">
                {report.attribution.before.ticketsPerDay?.toFixed(1) ?? "—"}
              </div>
              <div className="tabular-nums">
                {report.attribution.after.ticketsPerDay?.toFixed(1) ?? "—"}
              </div>

              <div className="text-muted-foreground">Average trade size</div>
              <div className="tabular-nums">
                {formatMoney(report.attribution.before.avgTicketBase, report.currency, 0)}
              </div>
              <div className="tabular-nums">
                {formatMoney(report.attribution.after.avgTicketBase, report.currency, 0)}
              </div>

              <div className="text-muted-foreground">Return</div>
              <div className="tabular-nums">
                {report.attribution.before.returnPct == null
                  ? "—"
                  : `${report.attribution.before.returnPct.toFixed(2)}%`}
              </div>
              <div className="tabular-nums">
                {report.attribution.after.returnPct == null
                  ? "—"
                  : `${report.attribution.after.returnPct.toFixed(2)}%`}
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Change in cost: {signedBps(report.attribution.deltas.frictionBpsPer30d)} per 30 days.{" "}
              {report.kpi.brokerCoverage >= 0.999
                ? "Every trade here is priced from the broker's own charge report."
                : report.kpi.brokerCoverage > 0
                  ? `${Math.round(report.kpi.brokerCoverage * 100)}% of trades are priced from the broker's charge report; the rest use our cost model.`
                  : "Costs are modelled — the broker has not reported fees on these trades yet."}{" "}
              {report.overlay.degraded ? "" : report.overlay.note}
            </p>

          </div>
        )}
      </CardContent>
    </Card>
  );
}
