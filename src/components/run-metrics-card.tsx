import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listRunMetrics, type RunMetricRow } from "@/lib/run-metrics-history.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  CartesianGrid,
} from "recharts";
import { Activity, RefreshCw } from "lucide-react";
import { formatUkTime } from "@/lib/uk-time";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART_ROLE,
  GRID_PROPS,
  LEGEND_PROPS,
  TICK_LINE,
} from "@/lib/chart-palette";
import { POLL } from "@/lib/query-keys";

const RANGES = [
  { label: "24h", hours: 24 },
  { label: "3d", hours: 72 },
  { label: "7d", hours: 24 * 7 },
] as const;

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m ${rs}s`;
}

export function RunMetricsCard() {
  const fetchMetrics = useServerFn(listRunMetrics);
  const [hours, setHours] = useState<number>(72);
  const q = useQuery({
    queryKey: ["run-metrics-history", hours],
    queryFn: () => fetchMetrics({ data: { hours } }),
    refetchInterval: POLL.SEMI_LIVE,
  });

  const rows: RunMetricRow[] = q.data ?? [];

  const chartData = useMemo(() => {
    // oldest → newest for the line/bar charts
    return [...rows].reverse().map((r) => ({
      ts: r.created_at,
      label: formatUkTime(r.created_at),
      duration_s: Math.round(r.duration_ms / 100) / 10,
      budget_exceeded: r.budget_exceeded_count,
      ok: r.portfolios_ok,
      err: r.portfolios_error,
      saxo_total: r.saxo_calls_total,
      saxo_err: r.saxo_calls_error,
      saxo_429: r.saxo_retries_429,
      triggered_by: r.triggered_by,
    }));
  }, [rows]);

  const summary = useMemo(() => {
    if (rows.length === 0) return null;
    const succ = rows.filter((r) => r.success).length;
    const fail = rows.length - succ;
    const totalDur = rows.reduce((a, r) => a + r.duration_ms, 0);
    const budget = rows.reduce((a, r) => a + r.budget_exceeded_count, 0);
    const saxo = rows.reduce((a, r) => a + r.saxo_calls_total, 0);
    const saxoErr = rows.reduce((a, r) => a + r.saxo_calls_error, 0);
    const pOk = rows.reduce((a, r) => a + r.portfolios_ok, 0);
    const pErr = rows.reduce((a, r) => a + r.portfolios_error, 0);
    return {
      count: rows.length,
      succ,
      fail,
      avgDurMs: Math.round(totalDur / rows.length),
      budget,
      saxo,
      saxoErr,
      portfolioSuccessRate: pOk + pErr > 0 ? (pOk / (pOk + pErr)) * 100 : null,
    };
  }, [rows]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4 text-primary" /> Run metrics — hourly &amp; manual runs
        </CardTitle>
        <div className="flex flex-wrap items-center gap-1">
          {RANGES.map((r) => (
            <Button
              key={r.hours}
              size="sm"
              variant={hours === r.hours ? "default" : "outline"}
              onClick={() => setHours(r.hours)}
            >
              {r.label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {q.isError && (
          <div className="text-sm text-destructive">
            Failed to load run metrics: {(q.error as Error).message}
          </div>
        )}
        {!q.isLoading && rows.length === 0 && (
          <div className="text-sm text-muted-foreground">No runs recorded in this window.</div>
        )}

        {summary && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <SummaryTile
              label="Runs"
              value={String(summary.count)}
              sub={`${summary.succ} ok · ${summary.fail} err`}
            />
            <SummaryTile
              label="Avg duration"
              value={fmtDuration(summary.avgDurMs)}
              sub={`${(summary.avgDurMs / 1000).toFixed(1)}s`}
            />
            <SummaryTile
              label="Budget exceeded"
              value={String(summary.budget)}
              sub={summary.budget > 0 ? "runs hit soft budget" : "within budget"}
              tone={summary.budget > 0 ? "warn" : "ok"}
            />
            <SummaryTile
              label="Saxo calls"
              value={String(summary.saxo)}
              sub={`${summary.saxoErr} errors`}
              tone={summary.saxoErr > 0 ? "warn" : "ok"}
            />
          </div>
        )}

        {chartData.length > 0 && (
          <>
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                Duration per run (seconds)
              </div>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid {...GRID_PROPS} />
                    <XAxis
                      dataKey="label"
                      tick={AXIS_TICK}
                      minTickGap={24}
                      axisLine={AXIS_LINE}
                      tickLine={TICK_LINE}
                    />
                    <YAxis width={64} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={TICK_LINE} />
                    <Tooltip />
                    <Legend {...LEGEND_PROPS} />
                    <Line
                      type="monotone"
                      dataKey="duration_s"
                      name="duration (s)"
                      stroke="var(--primary)"
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                Portfolios processed per run
              </div>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid {...GRID_PROPS} />
                    <XAxis
                      dataKey="label"
                      tick={AXIS_TICK}
                      minTickGap={24}
                      axisLine={AXIS_LINE}
                      tickLine={TICK_LINE}
                    />
                    <YAxis
                      width={64}
                      tick={AXIS_TICK}
                      allowDecimals={false}
                      axisLine={AXIS_LINE}
                      tickLine={TICK_LINE}
                    />
                    <Tooltip />
                    <Legend {...LEGEND_PROPS} />
                    <Bar dataKey="ok" name="success" stackId="p" fill={CHART_ROLE.positive} />
                    <Bar dataKey="err" name="error" stackId="p" fill={CHART_ROLE.negative} />
                    <Bar
                      dataKey="budget_exceeded"
                      name="budget exceeded"
                      fill={CHART_ROLE.benchmark}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                Saxo API calls per run
              </div>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid {...GRID_PROPS} />
                    <XAxis
                      dataKey="label"
                      tick={AXIS_TICK}
                      minTickGap={24}
                      axisLine={AXIS_LINE}
                      tickLine={TICK_LINE}
                    />
                    <YAxis
                      width={64}
                      tick={AXIS_TICK}
                      allowDecimals={false}
                      axisLine={AXIS_LINE}
                      tickLine={TICK_LINE}
                    />
                    <Tooltip />
                    <Legend {...LEGEND_PROPS} />
                    <Bar dataKey="saxo_total" name="total" fill="var(--primary)" />
                    <Bar dataKey="saxo_err" name="errors" fill={CHART_ROLE.negative} />
                    <Bar dataKey="saxo_429" name="429 retries" fill={CHART_ROLE.benchmark} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead className="text-right">Portfolios</TableHead>
                  <TableHead className="text-right">Budget</TableHead>
                  <TableHead className="text-right">Saxo (ok/err/429)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(0, 30).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatUkTime(r.created_at)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {r.triggered_by}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {r.success ? (
                        <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">ok</Badge>
                      ) : (
                        <Badge variant="destructive" title={r.error ?? undefined}>
                          error
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtDuration(r.duration_ms)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.portfolios_ok}/{r.portfolios_total}
                      {r.portfolios_error > 0 && (
                        <span className="text-destructive"> ({r.portfolios_error} err)</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.budget_exceeded_count}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.saxo_calls_ok}/{r.saxo_calls_error}/{r.saxo_retries_429}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "ok" | "warn";
}) {
  const toneCls =
    tone === "warn" ? "text-amber-500" : tone === "ok" ? "text-emerald-500" : "text-foreground";
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${toneCls}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
