import { createFileRoute, Link } from "@tanstack/react-router";
import { PortfolioTabs } from "@/components/portfolio-detail/portfolio-tabs";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getPerformanceReport } from "@/lib/trading.functions";
import { AppHeader } from "@/components/app-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART_ROLE,
  GRID_PROPS,
  REFERENCE_LINE,
  TICK_LINE,
} from "@/lib/chart-palette";
import { FeeBreakdownCard } from "@/components/fee-breakdown-card";

export const Route = createFileRoute("/portfolio/$id/report")({
  head: () => ({
    meta: [
      { title: "Performance Report — Aegis" },
      {
        name: "description",
        content:
          "Daily and weekly returns, volatility, drawdown, Sharpe and benchmark comparison for your portfolio.",
      },
      { property: "og:title", content: "Performance Report — Aegis" },
      {
        property: "og:description",
        content: "Track strategy returns, risk metrics, and alpha vs SPY.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ReportPage,
  errorComponent: ({ error, reset }) => (
    <div className="p-6 text-sm">
      <p className="text-destructive">{(error as Error).message}</p>
      <Button className="mt-3" onClick={reset}>
        Retry
      </Button>
    </div>
  ),
  notFoundComponent: () => <div className="p-6">Not found</div>,
});

function fmtPct(v: number | null | undefined, digits = 2) {
  if (v == null || Number.isNaN(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}
function fmtNum(v: number | null | undefined, digits = 2) {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}
function toneClass(v: number | null | undefined) {
  if (v == null) return "text-muted-foreground";
  if (v > 0) return "text-emerald-500";
  if (v < 0) return "text-rose-500";
  return "text-muted-foreground";
}

function ReportPage() {
  const { id } = Route.useParams();
  const fetchReport = useServerFn(getPerformanceReport);
  const [benchmark, setBenchmark] = useState<string>("SPY");
  const [windowDays, setWindowDays] = useState<number>(180);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["perf-report", id, benchmark, windowDays],
    queryFn: () => fetchReport({ data: { portfolio_id: id, benchmark, window_days: windowDays } }),
  });

  const currency = data?.portfolio.currency ?? "";

  return (
    <div className="min-h-dvh bg-background">
      <AppHeader />
      <div className="mx-auto max-w-7xl px-4"><PortfolioTabs id={id} /></div>
      <div className="mx-auto max-w-6xl 2xl:max-w-7xl px-4 py-5 sm:py-8">
        <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/portfolio/$id" params={{ id }}>
                <ArrowLeft className="h-4 w-4 mr-1" /> Back
              </Link>
            </Button>
            <h1 className="text-2xl font-semibold">Performance Report</h1>
            {data?.portfolio && (
              <Badge variant="outline">
                {data.portfolio.name} · {data.portfolio.risk_level}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Select value={benchmark} onValueChange={setBenchmark}>
              <SelectTrigger className="w-[130px]">
                <SelectValue placeholder="Benchmark" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SPY">SPY (S&P 500)</SelectItem>
                <SelectItem value="QQQ">QQQ (Nasdaq 100)</SelectItem>
                <SelectItem value="ACWI">ACWI (Global)</SelectItem>
                <SelectItem value="AGG">AGG (Bonds)</SelectItem>
              </SelectContent>
            </Select>
            <Select value={String(windowDays)} onValueChange={(v) => setWindowDays(Number(v))}>
              <SelectTrigger className="w-[130px]">
                <SelectValue placeholder="Window" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30">30 days</SelectItem>
                <SelectItem value="90">90 days</SelectItem>
                <SelectItem value="180">6 months</SelectItem>
                <SelectItem value="365">1 year</SelectItem>
                <SelectItem value="1095">3 years</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading report…</p>}
        {isError && <p className="text-sm text-destructive">{(error as Error).message}</p>}

        {data && data.empty && (
          <Card>
            <CardContent className="pt-6 text-sm text-muted-foreground">
              No equity snapshots yet — run at least one trading day or backtest to generate a
              performance report.
            </CardContent>
          </Card>
        )}

        {data && !data.empty && data.overall && (
          <>
            {/* KPI tiles */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-6">
              <KpiTile
                label="Total return"
                sub={`${data.overall.days} trading days · in ${currency}`}
                value={fmtPct(data.overall.strategy_return_pct)}
                tone={toneClass(data.overall.strategy_return_pct)}
              />
              <KpiTile
                label={`Alpha vs ${data.benchmark}`}
                sub={`Benchmark: ${fmtPct(data.overall.benchmark_return_pct)}`}
                value={fmtPct(data.overall.alpha_pct)}
                tone={toneClass(data.overall.alpha_pct)}
              />
              <KpiTile
                label="Sharpe (annualised)"
                sub={
                  data.benchmarkOverall
                    ? `Benchmark: ${fmtNum(data.benchmarkOverall.sharpe)}`
                    : "risk-adjusted return"
                }
                value={fmtNum(data.overall.sharpe)}
                tone={
                  data.overall.sharpe >= 1
                    ? "text-emerald-500"
                    : data.overall.sharpe >= 0
                      ? "text-foreground"
                      : "text-rose-500"
                }
              />
              <KpiTile
                label="Max drawdown"
                sub={
                  data.benchmarkOverall
                    ? `Benchmark: ${fmtPct(data.benchmarkOverall.max_drawdown_pct)}`
                    : "peak-to-trough loss"
                }
                value={fmtPct(data.overall.max_drawdown_pct)}
                tone="text-rose-500"
              />
              <KpiTile
                label="Volatility (annualised)"
                sub={
                  data.benchmarkOverall
                    ? `Benchmark: ${fmtPct(data.benchmarkOverall.volatility_pct)}`
                    : "daily returns σ × √252"
                }
                value={fmtPct(data.overall.volatility_pct)}
              />
              <KpiTile
                label="Best day"
                value={fmtPct(data.overall.best_day_pct)}
                tone="text-emerald-500"
              />
              <KpiTile
                label="Worst day"
                value={fmtPct(data.overall.worst_day_pct)}
                tone="text-rose-500"
              />
              <KpiTile
                label="Window"
                sub={`${data.overall.period_start} → ${data.overall.period_end}`}
                value={`${data.window_days}d`}
              />
            </div>

            {/* Equity vs benchmark chart */}
            <Card className="mb-6">
              <CardHeader>
                <CardTitle className="text-base">
                  Strategy vs {data.benchmark} (normalised to portfolio start)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div
                  className="h-80 w-full"
                  role="img"
                  aria-label={`Line chart comparing Strategy against ${data.benchmark} benchmark, ${data.strategy_series.length} points`}
                >
                  <span className="sr-only">
                    {(() => {
                      const s = data.strategy_series;
                      if (!s.length) return "No series data.";
                      const first = s[0];
                      const last = s[s.length - 1];
                      const stratPct =
                        first.strategy > 0
                          ? ((last.strategy - first.strategy) / first.strategy) * 100
                          : 0;
                      const fb = first.benchmark ?? 0;
                      const lb = last.benchmark ?? 0;
                      const benchPct = fb > 0 ? ((lb - fb) / fb) * 100 : 0;
                      return `Strategy ${stratPct >= 0 ? "up" : "down"} ${Math.abs(stratPct).toFixed(2)} percent. ${data.benchmark} ${benchPct >= 0 ? "up" : "down"} ${Math.abs(benchPct).toFixed(2)} percent. Both normalised to portfolio start.`;
                    })()}
                  </span>
                  <ResponsiveContainer>
                    <LineChart
                      data={data.strategy_series}
                      margin={{ top: 10, right: 20, left: 10, bottom: 10 }}
                    >
                      <CartesianGrid {...GRID_PROPS} />
                      <XAxis
                        dataKey="date"
                        tick={AXIS_TICK}
                        label={{
                          value: "Date",
                          position: "insideBottom",
                          offset: -4,
                          style: { fontSize: 12, fill: "var(--foreground)" },
                        }}
                        minTickGap={40}
                        axisLine={AXIS_LINE}
                        tickLine={TICK_LINE}
                      />
                      <YAxis
                        width={64}
                        tick={AXIS_TICK}
                        tickFormatter={(v) => `${(v as number).toLocaleString()}`}
                        label={{
                          value: `Value (${currency})`,
                          angle: -90,
                          position: "insideLeft",
                          style: { fontSize: 12, fill: "var(--foreground)" },
                        }}
                        axisLine={AXIS_LINE}
                        tickLine={TICK_LINE}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "var(--card)",
                          border: "1px solid var(--border)",
                          fontSize: 12,
                          color: "var(--popover-foreground)",
                        }}
                        formatter={(val: number | string, name) => [
                          typeof val === "number"
                            ? `${val.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${currency}`
                            : val,
                          name,
                        ]}
                      />
                      <Legend wrapperStyle={{ fontSize: 12, color: "var(--foreground)" }} />
                      <ReferenceLine
                        {...REFERENCE_LINE}
                        y={data.portfolio.starting_cash}
                        label={{ value: "Start", fill: "var(--foreground)", fontSize: 12 }}
                      />
                      <Line
                        type="monotone"
                        dataKey="strategy"
                        name="Strategy"
                        stroke={CHART_ROLE.positive}
                        strokeWidth={2}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="benchmark"
                        name={data.benchmark}
                        stroke={CHART_ROLE.benchmark}
                        strokeWidth={2}
                        strokeDasharray="6 3"
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <FeeBreakdownCard portfolioId={id} days={windowDays} />

            <Tabs defaultValue="weekly">
              <TabsList>
                <TabsTrigger value="daily">Daily ({data.daily.length})</TabsTrigger>
                <TabsTrigger value="weekly">Weekly ({data.weekly.length})</TabsTrigger>
              </TabsList>
              <TabsContent value="daily">
                <PeriodTable
                  rows={[...data.daily].reverse().slice(0, 30)}
                  benchmark={data.benchmark}
                  showRiskCols={false}
                  emptyLabel="No daily rows in this window."
                />
              </TabsContent>
              <TabsContent value="weekly">
                <PeriodTable
                  rows={[...data.weekly].reverse()}
                  benchmark={data.benchmark}
                  showRiskCols
                  emptyLabel="Need at least one full week to compute weekly stats."
                />
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>
    </div>
  );
}

function KpiTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`text-2xl font-semibold mt-1 ${tone ?? ""}`}>{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

type Bucket = {
  period_start: string;
  period_end: string;
  label: string;
  strategy_return_pct: number;
  benchmark_return_pct: number | null;
  alpha_pct: number | null;
  volatility_pct: number;
  max_drawdown_pct: number;
  sharpe: number;
  best_day_pct: number;
  worst_day_pct: number;
  days: number;
};

function PeriodTable({
  rows,
  benchmark,
  showRiskCols,
  emptyLabel,
}: {
  rows: Bucket[];
  benchmark: string;
  showRiskCols: boolean;
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">{emptyLabel}</p>;
  }
  return (
    <Card>
      <CardContent className="pt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-muted-foreground border-b">
              <th className="py-2 pr-3">Period</th>
              <th className="py-2 pr-3 text-right">Strategy</th>
              <th className="py-2 pr-3 text-right">{benchmark}</th>
              <th className="py-2 pr-3 text-right">Alpha</th>
              {showRiskCols && (
                <>
                  <th className="py-2 pr-3 text-right">Vol (ann.)</th>
                  <th className="py-2 pr-3 text-right">Max DD</th>
                  <th className="py-2 pr-3 text-right">Sharpe</th>
                </>
              )}
              <th className="py-2 pr-3 text-right">Best</th>
              <th className="py-2 pr-3 text-right">Worst</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.period_start + r.period_end} className="border-b last:border-b-0">
                <td className="py-2 pr-3">
                  <div>{r.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.days} day{r.days === 1 ? "" : "s"}
                  </div>
                </td>
                <td
                  className={`py-2 pr-3 text-right font-mono ${toneClass(r.strategy_return_pct)}`}
                >
                  {fmtPct(r.strategy_return_pct)}
                </td>
                <td
                  className={`py-2 pr-3 text-right font-mono ${toneClass(r.benchmark_return_pct)}`}
                >
                  {fmtPct(r.benchmark_return_pct)}
                </td>
                <td className={`py-2 pr-3 text-right font-mono ${toneClass(r.alpha_pct)}`}>
                  {fmtPct(r.alpha_pct)}
                </td>
                {showRiskCols && (
                  <>
                    <td className="py-2 pr-3 text-right font-mono">{fmtPct(r.volatility_pct)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-rose-500">
                      {fmtPct(r.max_drawdown_pct)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono">{fmtNum(r.sharpe)}</td>
                  </>
                )}
                <td className="py-2 pr-3 text-right font-mono text-emerald-500">
                  {fmtPct(r.best_day_pct)}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-rose-500">
                  {fmtPct(r.worst_day_pct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
