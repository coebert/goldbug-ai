import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getDiagnostics } from "@/lib/trading.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { AlertTriangle, Info, Activity, TrendingDown, Target, Gauge, Globe2 } from "lucide-react";
import { eventColor, type EventCategory } from "@/lib/global-events";
import { Explain } from "@/components/explain";
import { AXIS_LINE, AXIS_TICK, GRID_PROPS, TICK_LINE } from "@/lib/chart-palette";

type Props = { portfolioId: string };

const SIGNAL_LABELS: Record<string, string> = {
  sma_trend: "SMA trend",
  rsi: "RSI",
  price_change: "Price change",
  news_sentiment: "News sentiment",
  volatility: "Volatility",
};

function pct(n: number, digits = 1) {
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "" : ""}${n.toFixed(digits)}%`;
}

export function DiagnosticsPanel({ portfolioId }: Props) {
  const fn = useServerFn(getDiagnostics);
  const { data, isLoading, error } = useQuery({
    queryKey: ["diagnostics", portfolioId],
    queryFn: () => fn({ data: { portfolio_id: portfolioId, horizon_days: 5 } }),
  });

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Computing diagnostics…</p>;
  }
  if (error) {
    return (
      <p className="text-sm text-destructive">
        Failed to load diagnostics: {(error as Error).message}
      </p>
    );
  }
  if (!data) return null;

  const { summary, calibration, perSignal, weightDrift, behavior, flags, rolling, eventImpact } =
    data;

  return (
    <div className="space-y-4">
      {/* Behavior flags */}
      {flags.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Behavior signals
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {flags.map((f, i) => (
              <div
                key={i}
                className={`flex items-start gap-2 rounded-md border p-2 text-sm ${
                  f.severity === "warn"
                    ? "border-amber-500/30 bg-amber-500/5 text-amber-200"
                    : "border-border/60 bg-muted/20 text-muted-foreground"
                }`}
              >
                {f.severity === "warn" ? (
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                ) : (
                  <Info className="h-4 w-4 mt-0.5 shrink-0" />
                )}
                <span>{f.message}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Headline metrics */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricTile
          icon={<Target className="h-4 w-4" />}
          label={<Explain term="conviction">{`Win rate (${summary.horizonDays}d fwd)`}</Explain>}
          value={summary.evaluatedOutcomes > 0 ? `${(summary.winRate * 100).toFixed(0)}%` : "—"}
          sub={`${summary.evaluatedOutcomes} evaluated`}
        />
        <MetricTile
          icon={<Activity className="h-4 w-4" />}
          label={`Avg fwd return`}
          value={pct(summary.avgForwardReturnPct)}
          sub={`over ${summary.horizonDays} biz days`}
          tone={summary.avgForwardReturnPct >= 0 ? "pos" : "neg"}
        />
        <MetricTile
          icon={<TrendingDown className="h-4 w-4" />}
          label={<Explain term="max_drawdown">Max drawdown</Explain>}
          value={pct(summary.maxDrawdownPct)}
          sub={`current ${pct(summary.currentDrawdownPct)}`}
          tone={summary.maxDrawdownPct <= -10 ? "neg" : undefined}
        />
        <MetricTile
          icon={<Gauge className="h-4 w-4" />}
          label="Orders"
          value={String(summary.executedOrders)}
          sub={`${summary.rejectedCount} rejected · ${summary.decisions} decisions`}
        />
      </div>

      {/* Rolling win rate */}
      {rolling.length >= 3 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Rolling win rate (5-order window)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-48 w-full">
              <ResponsiveContainer>
                <LineChart data={rolling}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis
                    dataKey="index"
                    tick={AXIS_TICK}
                    label={{
                      value: "Trade #",
                      position: "insideBottom",
                      offset: -2,
                      fontSize: 12,
                      fill: "var(--foreground)",
                    }}
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                  />
                  <YAxis
                    tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                    domain={[0, 1]}
                    tick={AXIS_TICK}
                    width={64}
                    label={{
                      value: "Win rate (%)",
                      angle: -90,
                      position: "insideLeft",
                      offset: 8,
                      style: { textAnchor: "middle" },
                      fontSize: 12,
                      fill: "var(--foreground)",
                    }}
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                  />

                  <ReferenceLine y={0.5} stroke="var(--muted-foreground)" strokeDasharray="3 3" />
                  <Tooltip
                    formatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                    labelFormatter={(l) => `Trade #${l}`}
                    contentStyle={{
                      background: "var(--card)",
                      border: "1px solid var(--border)",
                      fontSize: 12,
                      color: "var(--popover-foreground)",
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="winRate"
                    stroke="var(--primary)"
                    dot={false}
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Calibration by conviction */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Calibration by conviction (order size)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">
            Larger allocations should correspond to higher win rates and returns. Diverging bars
            suggest the AI's confidence isn't matching outcomes.
          </p>
          <div className="h-56 w-full">
            <ResponsiveContainer>
              <BarChart data={calibration}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis
                  dataKey="bucket"
                  tick={AXIS_TICK}
                  label={{
                    value: "Order size bucket",
                    position: "insideBottom",
                    offset: -2,
                    fontSize: 12,
                    fill: "var(--foreground)",
                  }}
                  axisLine={AXIS_LINE}
                  tickLine={TICK_LINE}
                />
                <YAxis
                  yAxisId="left"
                  tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                  domain={[0, 1]}
                  tick={AXIS_TICK}
                  width={64}
                  label={{
                    value: "Win rate (%)",
                    angle: -90,
                    position: "insideLeft",
                    offset: 8,
                    style: { textAnchor: "middle" },
                    fontSize: 12,
                    fill: "var(--foreground)",
                  }}
                  axisLine={AXIS_LINE}
                  tickLine={TICK_LINE}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tickFormatter={(v) => `${v.toFixed(1)}%`}
                  tick={AXIS_TICK}
                  width={68}
                  label={{
                    value: "Avg fwd return (%)",
                    angle: 90,
                    position: "insideRight",
                    offset: 8,
                    style: { textAnchor: "middle" },
                    fontSize: 12,
                    fill: "var(--foreground)",
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
                  formatter={(v: number, name) =>
                    name === "winRate" ? `${(v * 100).toFixed(0)}%` : `${(v * 100).toFixed(2)}%`
                  }
                />
                <ReferenceLine yAxisId="right" y={0} stroke="var(--muted-foreground)" />
                <Bar yAxisId="left" dataKey="winRate" fill="var(--primary)" name="Win rate" />
                <Bar yAxisId="right" dataKey="avgReturn" fill="var(--chart-2)" name="Avg return" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-2 text-xs text-muted-foreground">
            {calibration.map((c) => (
              <div key={c.bucket} className="text-center">
                {c.bucket}: n={c.n}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Per-signal outcomes */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Outcome by dominant signal</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[420px] text-sm">
              <thead className="bg-muted/30 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Top signal</th>
                  <th className="px-3 py-2 text-right">Trades</th>
                  <th className="px-3 py-2 text-right">Win rate</th>
                  <th className="px-3 py-2 text-right">Avg return</th>
                </tr>
              </thead>
              <tbody>
                {perSignal.map((s) => (
                  <tr key={s.signal} className="border-t border-border">
                    <td className="px-3 py-2">{SIGNAL_LABELS[s.signal] ?? s.signal}</td>
                    <td className="px-3 py-2 text-right">{s.n}</td>
                    <td className="px-3 py-2 text-right">
                      {s.n === 0 ? "—" : `${(s.winRate * 100).toFixed(0)}%`}
                    </td>
                    <td
                      className={`px-3 py-2 text-right ${
                        s.n === 0 ? "" : s.avgReturn >= 0 ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {s.n === 0 ? "—" : `${(s.avgReturn * 100).toFixed(2)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Event impact */}
      {eventImpact && eventImpact.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Globe2 className="h-4 w-4" />
              Feature importance & calibration by global event
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-xs text-muted-foreground">
              Trades placed inside major event windows vs calm periods. Compare which signals
              dominated the AI's rationale and whether conviction matched outcomes.
            </p>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-muted/30 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Period</th>
                    <th className="px-3 py-2 text-right">N</th>
                    <th className="px-3 py-2 text-right">Win rate</th>
                    <th className="px-3 py-2 text-right">Avg return</th>
                    <th className="px-3 py-2 text-right">Avg conv.</th>
                    <th className="px-3 py-2 text-left">Top signal</th>
                    <th className="px-3 py-2 text-left w-[38%]">Feature importance</th>
                  </tr>
                </thead>
                <tbody>
                  {eventImpact.map((e) => {
                    const isCalm = e.id === "__calm";
                    const color = isCalm
                      ? "var(--muted-foreground)"
                      : eventColor(e.category as EventCategory);
                    const winPct = (e.winRate * 100).toFixed(0);
                    const avgRet = (e.avgReturn * 100).toFixed(2);
                    return (
                      <tr key={e.id} className="border-t border-border align-top">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span
                              className="inline-block h-2 w-2 rounded-sm shrink-0"
                              style={{ background: color }}
                            />
                            <div>
                              <div className="font-medium">{e.label}</div>
                              {!isCalm && (
                                <div className="text-[10px] text-muted-foreground">
                                  {e.start} → {e.end}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{e.n}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{winPct}%</td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${
                            e.avgReturn >= 0 ? "text-emerald-400" : "text-rose-400"
                          }`}
                        >
                          {avgRet}%
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {(e.avgConviction * 100).toFixed(0)}%
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {SIGNAL_LABELS[e.topSignal] ?? e.topSignal}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex h-2 w-full overflow-hidden rounded bg-muted/30">
                            {(Object.keys(SIGNAL_LABELS) as Array<keyof typeof SIGNAL_LABELS>).map(
                              (k, i) => {
                                const v = Math.max(0, Number(e.weights[k] ?? 0));
                                const palette = [
                                  "var(--primary)",
                                  "var(--chart-2)",
                                  "hsl(43 90% 55%)",
                                  "hsl(280 70% 62%)",
                                  "hsl(0 84% 60%)",
                                ];
                                return (
                                  <div
                                    key={k}
                                    style={{
                                      width: `${Math.min(100, v)}%`,
                                      background: palette[i % palette.length],
                                    }}
                                    title={`${SIGNAL_LABELS[k]}: ${v.toFixed(0)}%`}
                                  />
                                );
                              },
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground tabular-nums">
                            {(Object.keys(SIGNAL_LABELS) as Array<keyof typeof SIGNAL_LABELS>).map(
                              (k) => (
                                <span key={k}>
                                  {SIGNAL_LABELS[k]}:{" "}
                                  {Math.max(0, Number(e.weights[k] ?? 0)).toFixed(0)}%
                                </span>
                              ),
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Behavior drift */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Behavior drift (prior vs recent)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-xs text-muted-foreground">
            Comparing the first {behavior.priorDecisions} decisions to the most recent{" "}
            {behavior.recentDecisions}.
          </div>
          <div className="space-y-2">
            {weightDrift.map((d) => {
              const changed = Math.abs(d.delta) >= 15;
              return (
                <div key={d.signal} className="flex items-center gap-3 text-sm">
                  <div className="w-32 shrink-0 text-muted-foreground">
                    {SIGNAL_LABELS[d.signal] ?? d.signal}
                  </div>
                  <div className="flex-1 flex items-center gap-2">
                    <div className="h-2 flex-1 overflow-hidden rounded bg-muted/40">
                      <div
                        className="h-full bg-muted-foreground/50"
                        style={{ width: `${Math.min(100, d.prior)}%` }}
                      />
                    </div>
                    <span className="w-12 text-right text-xs text-muted-foreground">
                      {d.prior.toFixed(0)}%
                    </span>
                  </div>
                  <div className="flex-1 flex items-center gap-2">
                    <div className="h-2 flex-1 overflow-hidden rounded bg-muted/40">
                      <div
                        className={`h-full ${changed ? "bg-amber-500" : "bg-primary"}`}
                        style={{ width: `${Math.min(100, d.recent)}%` }}
                      />
                    </div>
                    <span className="w-12 text-right text-xs">{d.recent.toFixed(0)}%</span>
                  </div>
                  <Badge
                    variant={changed ? "destructive" : "secondary"}
                    className="w-16 justify-center"
                  >
                    {d.delta >= 0 ? "+" : ""}
                    {d.delta.toFixed(0)}pp
                  </Badge>
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <DriftStat
              label="Orders / day"
              prior={behavior.priorOrdersPerDay.toFixed(2)}
              recent={behavior.recentOrdersPerDay.toFixed(2)}
            />
            <DriftStat
              label="Buy share"
              prior={`${(behavior.priorBuyRatio * 100).toFixed(0)}%`}
              recent={`${(behavior.recentBuyRatio * 100).toFixed(0)}%`}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function MetricTile({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  value: string;
  sub?: string;
  tone?: "pos" | "neg";
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div
        className={`mt-1 text-xl font-semibold ${
          tone === "pos" ? "text-emerald-400" : tone === "neg" ? "text-rose-400" : ""
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function DriftStat({ label, prior, recent }: { label: string; prior: string; recent: string }) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-baseline gap-2 text-sm">
        <span className="text-muted-foreground">{prior}</span>
        <span className="text-muted-foreground">→</span>
        <span className="font-medium">{recent}</span>
      </div>
    </div>
  );
}
