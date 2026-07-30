import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getPerformanceAnalytics } from "@/lib/performance-analytics.functions";
import type { AttributionSlice } from "@/lib/performance-analytics.server";
import {
  AXIS_LINE,
  AXIS_TICK,
  GRID_PROPS,
  REFERENCE_LINE,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
} from "@/lib/chart-palette";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  Cell,
} from "recharts";

const WINDOWS = [
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "180d", value: 180 },
  { label: "1y", value: 365 },
];

interface Props {
  portfolioId: string;
}

export function PerformanceAnalyticsCard({ portfolioId }: Props) {
  const [windowDays, setWindowDays] = useState(90);
  const fetchFn = useServerFn(getPerformanceAnalytics);
  const q = useQuery({
    queryKey: ["performance-analytics", portfolioId, windowDays],
    queryFn: () => fetchFn({ data: { portfolioId, windowDays } }),
  });

  const data = q.data;
  const currency = data?.currency ?? "GBP";
  const fmtCcy = useMemo(
    () => new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }),
    [currency],
  );
  const fmtCcyPrecise = useMemo(
    () => new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 2 }),
    [currency],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
        <div>
          <CardTitle className="text-base">Performance analytics</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Equity, drawdown, and realised P&amp;L attribution across regime, sizing, exit and
            execution phases.
          </p>
        </div>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <Button
              key={w.value}
              size="sm"
              variant={windowDays === w.value ? "default" : "outline"}
              onClick={() => setWindowDays(w.value)}
              className="h-7 px-2 text-xs"
            >
              {w.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
        {data && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat
                label="Total return"
                value={data.totalReturnPct == null ? "—" : `${data.totalReturnPct.toFixed(2)}%`}
                tone={pctTone(data.totalReturnPct)}
              />
              <Stat label="Max drawdown" value={`${data.maxDrawdownPct.toFixed(2)}%`} tone="neg" />
              <Stat
                label="Realised P&L"
                value={fmtCcyPrecise.format(data.totalRealizedPnl)}
                tone={pctTone(data.totalRealizedPnl)}
              />
              <Stat label="Round-trips" value={String(data.roundTrips)} />
            </div>

            <ChartBlock title="Equity curve">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart
                  data={data.equityCurve}
                  margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                >
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis
                    dataKey="date"
                    tick={AXIS_TICK}
                    minTickGap={40}
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                  />
                  <YAxis
                    tick={AXIS_TICK}
                    tickFormatter={(v: number) => fmtCcy.format(v)}
                    width={70}
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                  />
                  <Tooltip
                    formatter={(v: number) => fmtCcyPrecise.format(v)}
                    labelClassName="text-xs"
                    contentStyle={TOOLTIP_CONTENT_STYLE}
                  />
                  <Line
                    type="monotone"
                    dataKey="equity"
                    stroke="var(--primary)"
                    dot={false}
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartBlock>

            <ChartBlock title="Drawdown (peak-to-trough %)">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart
                  data={data.drawdownCurve}
                  margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="ddFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--destructive)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="var(--destructive)" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis
                    dataKey="date"
                    tick={AXIS_TICK}
                    minTickGap={40}
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                  />
                  <YAxis
                    tick={AXIS_TICK}
                    tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                    width={64}
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                  />
                  <Tooltip
                    formatter={(v: number) => `${v.toFixed(2)}%`}
                    labelClassName="text-xs"
                    contentStyle={TOOLTIP_CONTENT_STYLE}
                  />
                  <ReferenceLine {...REFERENCE_LINE} y={0} />
                  <Area
                    type="monotone"
                    dataKey="drawdownPct"
                    stroke="var(--destructive)"
                    fill="url(#ddFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </ChartBlock>

            <div className="grid gap-6 lg:grid-cols-2">
              <AttributionBlock
                title="Regime attribution"
                subtitle="Realised P&L grouped by market regime at entry."
                slices={data.regimeAttribution}
                fmt={fmtCcyPrecise}
              />
              <AttributionBlock
                title="Sizing attribution"
                subtitle="Baseline vs conviction bonus vs risk-parity sizing."
                slices={data.sizingAttribution}
                fmt={fmtCcyPrecise}
              />
              <AttributionBlock
                title="Exit attribution"
                subtitle="Which exit trigger closed each round-trip."
                slices={data.exitAttribution}
                fmt={fmtCcyPrecise}
              />
              <AttributionBlock
                title="Execution attribution"
                subtitle="Impact of TOD gates, haircuts, and order slicing."
                slices={data.executionAttribution}
                fmt={fmtCcyPrecise}
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function pctTone(v: number | null | undefined): "pos" | "neg" | undefined {
  if (v == null) return undefined;
  if (v > 0) return "pos";
  if (v < 0) return "neg";
  return undefined;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={`mt-1 text-lg font-semibold ${
          tone === "pos" ? "text-emerald-500" : tone === "neg" ? "text-destructive" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function ChartBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-2">{title}</div>
      {children}
    </div>
  );
}

function AttributionBlock({
  title,
  subtitle,
  slices,
  fmt,
}: {
  title: string;
  subtitle: string;
  slices: AttributionSlice[];
  fmt: Intl.NumberFormat;
}) {
  const chartData = slices.map((s) => ({ ...s }));
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">{title}</div>
        <Badge variant="outline" className="text-[10px]">
          {slices.reduce((n, s) => n + s.trips, 0)} trips
        </Badge>
      </div>
      <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>
      {slices.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">No round-trip trades in this window.</p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={Math.max(140, slices.length * 28 + 20)}>
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 4, right: 12, left: 4, bottom: 4 }}
            >
              <CartesianGrid {...GRID_PROPS} horizontal={false} />
              <XAxis
                type="number"
                tick={AXIS_TICK}
                tickFormatter={(v: number) => fmt.format(v)}
                axisLine={AXIS_LINE}
                tickLine={TICK_LINE}
              />
              <YAxis
                type="category"
                dataKey="label"
                tick={AXIS_TICK}
                width={110}
                axisLine={AXIS_LINE}
                tickLine={TICK_LINE}
              />
              <Tooltip
                formatter={(v: number) => fmt.format(v)}
                labelClassName="text-xs"
                contentStyle={TOOLTIP_CONTENT_STYLE}
              />
              <ReferenceLine {...REFERENCE_LINE} x={0} />
              <Bar dataKey="realizedPnl" radius={[0, 4, 4, 0]}>
                {chartData.map((s) => (
                  <Cell
                    key={s.key}
                    fill={s.realizedPnl >= 0 ? "var(--primary)" : "var(--destructive)"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="mt-2 grid grid-cols-4 gap-1 text-[10px] uppercase text-muted-foreground">
            <div className="col-span-2">Bucket</div>
            <div className="text-right">Trips</div>
            <div className="text-right">Win %</div>
          </div>
          <div className="divide-y">
            {slices.map((s) => (
              <div key={s.key} className="grid grid-cols-4 gap-1 py-1 text-xs">
                <div className="col-span-2 truncate">{s.label}</div>
                <div className="text-right">{s.trips}</div>
                <div className="text-right">
                  {s.winRatePct == null ? "—" : `${s.winRatePct.toFixed(0)}%`}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
