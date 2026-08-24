import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, AlertTriangle, PackageX, TrendingDown } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART_ROLE,
  GRID_PROPS,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_ITEM_STYLE,
  TOOLTIP_LABEL_STYLE,
} from "@/lib/chart-palette";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getReconMetrics } from "@/lib/recon-metrics.functions";

function Stat({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Activity;
  tone?: "danger" | "muted";
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon
          className={`h-3.5 w-3.5 ${tone === "danger" ? "text-destructive" : "text-muted-foreground"}`}
        />
        {label}
      </div>
      <div
        className={`mt-1 text-xl font-semibold tabular-nums ${tone === "danger" ? "text-destructive" : ""}`}
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function ReconMetricsCard({
  portfolioId,
  windowDays = 14,
}: {
  portfolioId?: string;
  windowDays?: number;
}) {
  const load = useServerFn(getReconMetrics);
  const { data, isLoading } = useQuery({
    queryKey: ["recon-metrics", portfolioId ?? "all", windowDays],
    queryFn: () =>
      load({ data: { ...(portfolioId ? { portfolioId } : {}), windowDays } }),
    staleTime: 60_000,
  });

  const chart = (data?.buckets ?? []).map((b) => ({
    day: new Date(b.start).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      timeZone: "Europe/London",
    }),
    dropped: b.droppedLegs,
    stranded: b.strandedNearMisses,
    adverse: b.adversePrints,
  }));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4 text-primary" />
          Reconciliation outcomes
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            last {windowDays}d
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading metrics…</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">No reconciliation data yet.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat
                label="Dropped legs"
                value={String(data.totals.droppedLegs)}
                hint={`latest ${data.trend.droppedLegsLatest} vs ${data.trend.droppedLegsBaseline} baseline`}
                icon={PackageX}
                {...(data.totals.droppedLegs > 0 ? { tone: "danger" as const } : {})}
              />
              <Stat
                label="Stranded near-misses"
                value={String(data.totals.strandedNearMisses)}
                hint={`${Math.round(data.totals.strandedQuantity)} units left on risk`}
                icon={AlertTriangle}
                {...(data.totals.strandedNearMisses > 0
                  ? { tone: "danger" as const }
                  : {})}
              />
              <Stat
                label="Adverse prints"
                value={String(data.totals.adversePrints)}
                hint={`mean ${data.totals.adverseBpsMean}bps, worst ${Math.round(data.totals.worstAdverseBps)}bps`}
                icon={TrendingDown}
              />
              <Stat
                label="Total mismatches"
                value={String(data.totals.discrepancies)}
                hint={`${data.totals.criticalCount} critical`}
                icon={Activity}
              />
            </div>

            {data.alerts.length > 0 ? (
              <div className="space-y-2">
                {data.alerts.map((a) => (
                  <div
                    key={a.key}
                    className="rounded-lg border border-destructive/40 bg-destructive/5 p-3"
                  >
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={
                          a.severity === "critical"
                            ? "border-destructive/50 text-destructive"
                            : "border-border text-muted-foreground"
                        }
                      >
                        {a.severity}
                      </Badge>
                      <span className="text-sm font-medium">{a.title}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{a.detail}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No thresholds breached — routing is landing as intended.
              </p>
            )}

            <div className="h-48 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chart} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis
                    dataKey="day"
                    tick={AXIS_TICK}
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={AXIS_TICK}
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                    width={46}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_CONTENT_STYLE}
                    labelStyle={TOOLTIP_LABEL_STYLE}
                    itemStyle={TOOLTIP_ITEM_STYLE}
                  />
                  <Area
                    type="monotone"
                    dataKey="dropped"
                    name="Dropped legs"
                    stroke={CHART_ROLE.negative}
                    fill={CHART_ROLE.negative}
                    fillOpacity={0.2}
                  />
                  <Area
                    type="monotone"
                    dataKey="stranded"
                    name="Stranded near-misses"
                    stroke={CHART_ROLE.warning}
                    fill={CHART_ROLE.warning}
                    fillOpacity={0.15}
                  />
                  <Area
                    type="monotone"
                    dataKey="adverse"
                    name="Adverse prints"
                    stroke={CHART_ROLE.neutral}
                    fill={CHART_ROLE.neutral}
                    fillOpacity={0.12}
                  />

                </AreaChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
