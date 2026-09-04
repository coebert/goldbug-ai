import { createFileRoute, Link } from "@tanstack/react-router";
import { PortfolioTabs } from "@/components/portfolio-detail/portfolio-tabs";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getAttributionDashboard } from "@/lib/attribution.functions";
import { AppHeader } from "@/components/app-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft } from "lucide-react";
import { CollapsibleLegend } from "@/components/ui/collapsible-legend";
import {
  BarChart,
  Bar,
  Cell,
  LabelList,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  ScatterChart,
  Scatter,
} from "recharts";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART_NEUTRAL_SERIES,
  CHART_ROLE,
  GRID_PROPS,
  LEGEND_PROPS,
  OKABE_ITO,
  REFERENCE_LINE,
  TICK_LINE,
} from "@/lib/chart-palette";

export const Route = createFileRoute("/portfolio/$id/attribution")({
  head: () => ({
    meta: [
      { title: "Attribution Dashboard — Aegis" },
      {
        name: "description",
        content: "Signal, news, and regime/event attribution for each trade.",
      },
    ],
  }),
  component: AttributionPage,
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

const SIGNAL_COLORS: Record<string, string> = {
  sma_trend: OKABE_ITO.skyBlue,
  rsi: "#a855f7",
  price_change: "#f59e0b",
  news_sentiment: CHART_ROLE.positive,
  volatility: "#ef4444",
};
const SIGNALS = ["sma_trend", "rsi", "price_change", "news_sentiment", "volatility"] as const;

function fmtPct(v: number | null | undefined, digits = 2) {
  if (v == null) return "—";
  // Always show a sign glyph so meaning is not colour-only.
  const sign = v > 0 ? "▲ +" : v < 0 ? "▼ " : "";
  return `${sign}${v.toFixed(digits)}%`;
}
function fmtRate(v: number | null | undefined) {
  return v == null ? "—" : `${(v * 100).toFixed(0)}%`;
}

function AttributionPage() {
  const { id } = Route.useParams();
  const [windowDays, setWindowDays] = useState(90);
  const [horizonDays, setHorizonDays] = useState(5);
  const fetchFn = useServerFn(getAttributionDashboard);
  const q = useQuery({
    queryKey: ["attribution", id, windowDays, horizonDays],
    queryFn: () => fetchFn({ data: { portfolioId: id, windowDays, horizonDays } }),
  });

  const data = q.data;

  return (
    <div className="min-h-dvh bg-background">
      <AppHeader />
      <div className="mx-auto max-w-7xl px-4"><PortfolioTabs id={id} /></div>
      <div className="mx-auto max-w-7xl p-4 md:p-6 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <Link
              to="/portfolio/$id/"
              params={{ id }}
              className="text-xs text-muted-foreground hover:underline inline-flex items-center gap-1"
            >
              <ArrowLeft className="h-3 w-3" /> Back to portfolio
            </Link>
            <h1 className="text-xl md:text-2xl font-semibold mt-1">Attribution dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Every executed trade's forward return, split by signal contribution, news impact, and
              regime/event penalties.
            </p>
          </div>
          <div className="flex items-end gap-3">
            <label className="text-xs flex flex-col">
              <span className="text-muted-foreground mb-1">Window (days)</span>
              <select
                className="border rounded px-2 py-1 bg-background text-sm"
                value={windowDays}
                onChange={(e) => setWindowDays(Number(e.target.value))}
              >
                {[30, 60, 90, 180, 365].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs flex flex-col">
              <span className="text-muted-foreground mb-1">Horizon (days)</span>
              <select
                className="border rounded px-2 py-1 bg-background text-sm"
                value={horizonDays}
                onChange={(e) => setHorizonDays(Number(e.target.value))}
              >
                {[1, 3, 5, 10, 20].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {q.isLoading && (
          <div className="text-sm text-muted-foreground">
            Computing forward returns and joining signals…
          </div>
        )}
        {q.isError && <div className="text-sm text-destructive">{(q.error as Error).message}</div>}

        {data && (
          <>
            {/* Overall signal contribution */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Overall signal attribution ({data.overall.attributed_trades} attributable trades)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground mb-3">{data.overall.notes}</p>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={data.overall.rows.map((r) => ({
                        signal: r.signal,
                        contribution: r.contribution_pct,
                        win: r.win_rate == null ? null : r.win_rate * 100,
                      }))}
                    >
                      <CartesianGrid {...GRID_PROPS} />
                      <XAxis
                        dataKey="signal"
                        tick={AXIS_TICK}
                        stroke="var(--foreground)"
                        axisLine={AXIS_LINE}
                        tickLine={TICK_LINE}
                      />
                      <YAxis
                        width={64}
                        yAxisId="left"
                        tick={AXIS_TICK}
                        stroke="var(--foreground)"
                        label={{
                          value: "Contribution to P&L (%)",
                          angle: -90,
                          position: "insideLeft",
                          fill: "var(--foreground)",
                          style: { fontSize: 12 },
                        }}
                        axisLine={AXIS_LINE}
                        tickLine={TICK_LINE}
                      />
                      <YAxis
                        width={64}
                        yAxisId="right"
                        tick={AXIS_TICK}
                        orientation="right"
                        stroke="var(--foreground)"
                        domain={[0, 100]}
                        label={{
                          value: "Win rate (%)",
                          angle: 90,
                          position: "insideRight",
                          fill: "var(--foreground)",
                          style: { fontSize: 12 },
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
                      />
                      <Legend {...LEGEND_PROPS} content={<CollapsibleLegend />} />
                      <ReferenceLine {...REFERENCE_LINE} yAxisId="left" y={0} />
                      <Bar yAxisId="left" dataKey="contribution" name="Signed contribution (%)">
                        {data.overall.rows.map((r) => (
                          <Cell
                            key={r.signal}
                            fill={
                              r.contribution_pct >= 0 ? CHART_ROLE.positive : CHART_ROLE.negative
                            }
                          />
                        ))}
                        <LabelList
                          dataKey="contribution"
                          position="top"
                          style={{
                            fontSize: 12,
                            fill: "var(--foreground)",
                            fontVariantNumeric: "tabular-nums",
                          }}
                          formatter={(v: number) =>
                            v == null ? "" : `${v >= 0 ? "▲ +" : "▼ "}${v.toFixed(2)}%`
                          }
                        />
                      </Bar>
                      <Bar
                        yAxisId="right"
                        dataKey="win"
                        name="Win rate (%)"
                        fill={CHART_NEUTRAL_SERIES}
                        opacity={0.6}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 text-xs text-muted-foreground">
                  Suggested prior tilt (used by the AI next tick):{" "}
                  {SIGNALS.map((k) => `${k}=${data.overall.suggested_prior[k].toFixed(0)}`).join(
                    ", ",
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Benchmark-relative attribution (alpha vs SPY) */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Benchmark-relative attribution (alpha vs SPY)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
                  <div>
                    <div className="text-xs text-muted-foreground">Trades scored</div>
                    <div className="text-lg font-semibold">{data.alpha_summary.n}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Avg strategy return</div>
                    <div
                      className={`text-lg font-semibold ${(data.alpha_summary.avg_return_pct ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}
                    >
                      {fmtPct(data.alpha_summary.avg_return_pct)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Avg SPY return</div>
                    <div className="text-lg font-semibold">
                      {fmtPct(data.alpha_summary.avg_benchmark_pct)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Avg alpha</div>
                    <div
                      className={`text-lg font-semibold ${(data.alpha_summary.avg_alpha_pct ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}
                    >
                      {fmtPct(data.alpha_summary.avg_alpha_pct)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Alpha win rate</div>
                    <div className="text-lg font-semibold">
                      {fmtRate(data.alpha_summary.alpha_win_rate)}
                    </div>
                  </div>
                </div>
                {data.cumulative_alpha.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Not enough scored trades to plot cumulative alpha yet.
                  </p>
                ) : (
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data.cumulative_alpha}>
                        <CartesianGrid {...GRID_PROPS} />
                        <XAxis
                          dataKey="trade_date"
                          stroke="var(--muted-foreground)"
                          label={{
                            value: "Trade date",
                            position: "insideBottom",
                            offset: -5,
                            fill: "var(--muted-foreground)",
                            style: { fontSize: 12 },
                          }}
                          axisLine={AXIS_LINE}
                          tickLine={TICK_LINE}
                        />
                        <YAxis
                          width={64}
                          stroke="var(--muted-foreground)"
                          label={{
                            value: "Cumulative return (%)",
                            angle: -90,
                            position: "insideLeft",
                            fill: "var(--muted-foreground)",
                            style: { fontSize: 12 },
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
                        />
                        <Legend {...LEGEND_PROPS} content={<CollapsibleLegend />} />
                        <ReferenceLine {...REFERENCE_LINE} y={0} />
                        <Line
                          type="monotone"
                          dataKey="strategy"
                          name="Strategy (solid)"
                          stroke={CHART_ROLE.positive}
                          strokeWidth={2}
                          dot={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="benchmark"
                          name="SPY (dashed)"
                          stroke={CHART_ROLE.benchmark}
                          strokeWidth={2}
                          strokeDasharray="6 3"
                          dot={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="alpha"
                          name="Alpha = Strategy − SPY (dotted)"
                          stroke={CHART_ROLE.highlight}
                          strokeWidth={2}
                          strokeDasharray="2 3"
                          dot={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-2">
                  Alpha = trade forward return − SPY over the same {horizonDays}-day window (SPY is
                  long-only; shorts are measured against being long the market). Positive alpha
                  means the pick beat "just buy SPY".
                </p>
              </CardContent>
            </Card>

            {/* Cumulative signal contribution over time */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Cumulative signal contribution over time
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.cumulative_by_signal.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Not enough evaluable trades in this window yet.
                  </p>
                ) : (
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data.cumulative_by_signal}>
                        <CartesianGrid {...GRID_PROPS} />
                        <XAxis
                          dataKey="trade_date"
                          stroke="var(--muted-foreground)"
                          label={{
                            value: "Trade date",
                            position: "insideBottom",
                            offset: -5,
                            fill: "var(--muted-foreground)",
                            style: { fontSize: 12 },
                          }}
                          axisLine={AXIS_LINE}
                          tickLine={TICK_LINE}
                        />
                        <YAxis
                          width={64}
                          stroke="var(--muted-foreground)"
                          label={{
                            value: "Cumulative return contribution (%)",
                            angle: -90,
                            position: "insideLeft",
                            fill: "var(--muted-foreground)",
                            style: { fontSize: 12 },
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
                        />
                        <Legend {...LEGEND_PROPS} content={<CollapsibleLegend />} />
                        <ReferenceLine {...REFERENCE_LINE} y={0} />
                        {SIGNALS.map((k) => (
                          <Line
                            key={k}
                            type="monotone"
                            dataKey={k}
                            stroke={SIGNAL_COLORS[k]}
                            strokeWidth={2}
                            dot={false}
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              {/* News impact */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    News sentiment impact on forward return
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {data.news_buckets.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No news-scored trades in this window.
                    </p>
                  ) : (
                    <div className="h-60">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={data.news_buckets}>
                          <CartesianGrid {...GRID_PROPS} />
                          <XAxis
                            dataKey="bucket"
                            stroke="var(--muted-foreground)"
                            tick={AXIS_TICK}
                            axisLine={AXIS_LINE}
                            tickLine={TICK_LINE}
                          />
                          <YAxis
                            width={64}
                            stroke="var(--muted-foreground)"
                            label={{
                              value: "Avg forward return (%)",
                              angle: -90,
                              position: "insideLeft",
                              fill: "var(--muted-foreground)",
                              style: { fontSize: 12 },
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
                          />
                          <ReferenceLine {...REFERENCE_LINE} y={0} />
                          <Bar
                            dataKey="avg_return_pct"
                            name="Avg return (%)"
                            fill={CHART_ROLE.positive}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Scatter of every trade's news_score vs its {horizonDays}-day return follows.
                  </p>
                  {data.trades.some(
                    (t) => t.forward_return_pct != null && t.news_score != null,
                  ) && (
                    <div className="h-56 mt-2">
                      <ResponsiveContainer width="100%" height="100%">
                        <ScatterChart>
                          <CartesianGrid {...GRID_PROPS} />
                          <XAxis
                            type="number"
                            dataKey="news_score"
                            name="News score"
                            domain={[-1, 1]}
                            stroke="var(--muted-foreground)"
                            label={{
                              value: "News score (-1..+1)",
                              position: "insideBottom",
                              offset: -5,
                              fill: "var(--muted-foreground)",
                              style: { fontSize: 12 },
                            }}
                            axisLine={AXIS_LINE}
                            tickLine={TICK_LINE}
                          />
                          <YAxis
                            width={64}
                            type="number"
                            dataKey="forward_return_pct"
                            name="Return (%)"
                            stroke="var(--muted-foreground)"
                            label={{
                              value: "Forward return (%)",
                              angle: -90,
                              position: "insideLeft",
                              fill: "var(--muted-foreground)",
                              style: { fontSize: 12 },
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
                          />
                          <ReferenceLine {...REFERENCE_LINE} y={0} />
                          <Scatter
                            data={data.trades
                              .filter((t) => t.forward_return_pct != null && t.news_score != null)
                              .map((t) => ({
                                news_score: t.news_score,
                                forward_return_pct: t.forward_return_pct,
                              }))}
                            fill={OKABE_ITO.skyBlue}
                          />
                        </ScatterChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Regime + penalty tables */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Regime & penalty breakdown</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <div className="text-xs font-medium mb-1 text-muted-foreground">
                      By regime at trade time
                    </div>
                    {data.regime_breakdown.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No regime-tagged trades.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[420px] text-sm">
                          <thead className="text-xs text-muted-foreground">
                            <tr>
                              <th className="text-left py-1">Regime</th>
                              <th className="text-right">n</th>
                              <th className="text-right">Avg return</th>
                              <th className="text-right">Win rate</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.regime_breakdown.map((r) => (
                              <tr key={r.regime} className="border-t border-border/50">
                                <td className="py-1">{r.regime.replace(/_/g, " ")}</td>
                                <td className="text-right">{r.n}</td>
                                <td
                                  className={`text-right ${(r.avg_return_pct ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}
                                >
                                  {fmtPct(r.avg_return_pct)}
                                </td>
                                <td className="text-right">{fmtRate(r.win_rate)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="text-xs font-medium mb-1 text-muted-foreground">
                      By guardrail penalty applied
                    </div>
                    {data.penalty_breakdown.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No penalty-tagged trades.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[420px] text-sm">
                          <thead className="text-xs text-muted-foreground">
                            <tr>
                              <th className="text-left py-1">Penalty</th>
                              <th className="text-right">n</th>
                              <th className="text-right">Avg return</th>
                              <th className="text-right">Win rate</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.penalty_breakdown.map((r) => (
                              <tr key={r.bucket} className="border-t border-border/50">
                                <td className="py-1">{r.bucket.replace(/_/g, " ")}</td>
                                <td className="text-right">{r.n}</td>
                                <td
                                  className={`text-right ${(r.avg_return_pct ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}
                                >
                                  {fmtPct(r.avg_return_pct)}
                                </td>
                                <td className="text-right">{fmtRate(r.win_rate)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground mt-2">
                      "event_*" = pre-trade macro/earnings penalty severity; "cooldown" = post-loss
                      halving; "liquidity" = trimmed to 1% of 20d ADV.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Trade-level table */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Trade-by-trade attribution ({data.trades.length} trades)
                </CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left py-1 pr-2">Date</th>
                      <th className="text-left pr-2">Symbol</th>
                      <th className="text-left pr-2">Side</th>
                      <th className="text-right pr-2">Fwd return</th>
                      <th className="text-right pr-2">SPY</th>
                      <th className="text-right pr-2">Alpha</th>
                      <th className="text-right pr-2">News</th>

                      <th className="text-left pr-2">Regime</th>
                      <th className="text-left pr-2">Penalties</th>
                      <th className="text-left">Top signal contrib</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.trades.slice(0, 150).map((t, i) => {
                      const topContrib = SIGNALS.map((k) => ({ k, v: t.signal_contrib[k] }))
                        .filter((x) => Math.abs(x.v) > 0.001)
                        .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
                        .slice(0, 2);
                      const penalties: string[] = [];
                      if (t.event_penalty < 0.99)
                        penalties.push(`event ×${t.event_penalty.toFixed(2)}`);
                      if (t.cooldown_applied) penalties.push("cooldown");
                      if (t.liquidity_capped) penalties.push("liquidity");
                      return (
                        <tr key={i} className="border-t border-border/40">
                          <td className="py-1 pr-2">{t.trade_date}</td>
                          <td className="pr-2 font-mono">{t.symbol}</td>
                          <td className="pr-2">
                            <Badge variant={t.side === "buy" ? "default" : "secondary"}>
                              {t.side}
                            </Badge>
                          </td>
                          <td
                            className={`text-right pr-2 ${(t.forward_return_pct ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}
                          >
                            {fmtPct(t.forward_return_pct)}
                          </td>
                          <td className="text-right pr-2 text-muted-foreground">
                            {fmtPct(t.benchmark_return_pct)}
                          </td>
                          <td
                            className={`text-right pr-2 ${(t.alpha_pct ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}
                          >
                            {fmtPct(t.alpha_pct)}
                          </td>
                          <td className="text-right pr-2">
                            {t.news_score == null ? "—" : t.news_score.toFixed(2)}
                          </td>

                          <td className="pr-2">{t.regime ?? "—"}</td>
                          <td className="pr-2">
                            {penalties.length ? (
                              penalties.join(", ")
                            ) : (
                              <span className="text-muted-foreground">none</span>
                            )}
                          </td>
                          <td>
                            {topContrib.length === 0 ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              topContrib.map((x) => (
                                <span
                                  key={x.k}
                                  className="mr-2"
                                  style={{ color: SIGNAL_COLORS[x.k] }}
                                >
                                  {x.k} {x.v >= 0 ? "+" : ""}
                                  {x.v.toFixed(2)}%
                                </span>
                              ))
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {data.trades.length > 150 && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Showing 150 most recent of {data.trades.length}.
                  </p>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
