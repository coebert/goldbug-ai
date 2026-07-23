import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getAttributionDashboard } from "@/lib/attribution.functions";
import { AppHeader } from "@/components/app-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft } from "lucide-react";
import {
  BarChart,
  Bar,
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

export const Route = createFileRoute("/portfolio/$id/attribution")({
  head: () => ({
    meta: [
      { title: "Attribution Dashboard — Aegis" },
      { name: "description", content: "Signal, news, and regime/event attribution for each trade." },
    ],
  }),
  component: AttributionPage,
  errorComponent: ({ error, reset }) => (
    <div className="p-6 text-sm">
      <p className="text-destructive">{(error as Error).message}</p>
      <Button className="mt-3" onClick={reset}>Retry</Button>
    </div>
  ),
  notFoundComponent: () => <div className="p-6">Not found</div>,
});

const SIGNAL_COLORS: Record<string, string> = {
  sma_trend: "#06b6d4",
  rsi: "#a855f7",
  price_change: "#f59e0b",
  news_sentiment: "#22c55e",
  volatility: "#ef4444",
};
const SIGNALS = ["sma_trend", "rsi", "price_change", "news_sentiment", "volatility"] as const;

function fmtPct(v: number | null | undefined, digits = 2) {
  return v == null ? "—" : `${v.toFixed(digits)}%`;
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
    <div className="min-h-screen bg-background">
      <AppHeader />
      <div className="mx-auto max-w-7xl p-4 md:p-6 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <Link to="/portfolio/$id" params={{ id }} className="text-xs text-muted-foreground hover:underline inline-flex items-center gap-1">
              <ArrowLeft className="h-3 w-3" /> Back to portfolio
            </Link>
            <h1 className="text-xl md:text-2xl font-semibold mt-1">Attribution dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Every executed trade's forward return, split by signal contribution, news impact, and regime/event penalties.
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
                {[30, 60, 90, 180, 365].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="text-xs flex flex-col">
              <span className="text-muted-foreground mb-1">Horizon (days)</span>
              <select
                className="border rounded px-2 py-1 bg-background text-sm"
                value={horizonDays}
                onChange={(e) => setHorizonDays(Number(e.target.value))}
              >
                {[1, 3, 5, 10, 20].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          </div>
        </div>

        {q.isLoading && <div className="text-sm text-muted-foreground">Computing forward returns and joining signals…</div>}
        {q.isError && <div className="text-sm text-destructive">{(q.error as Error).message}</div>}

        {data && (
          <>
            {/* Overall signal contribution */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Overall signal attribution ({data.overall.attributed_trades} attributable trades)</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground mb-3">{data.overall.notes}</p>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.overall.rows.map((r) => ({ signal: r.signal, contribution: r.contribution_pct, win: r.win_rate == null ? null : r.win_rate * 100 }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="signal" stroke="hsl(var(--muted-foreground))" />
                      <YAxis yAxisId="left" stroke="hsl(var(--muted-foreground))" label={{ value: "Contribution to P&L (%)", angle: -90, position: "insideLeft", fill: "hsl(var(--muted-foreground))", style: { fontSize: 11 } }} />
                      <YAxis yAxisId="right" orientation="right" stroke="hsl(var(--muted-foreground))" domain={[0, 100]} label={{ value: "Win rate (%)", angle: 90, position: "insideRight", fill: "hsl(var(--muted-foreground))", style: { fontSize: 11 } }} />
                      <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                      <Legend />
                      <ReferenceLine yAxisId="left" y={0} stroke="hsl(var(--muted-foreground))" />
                      <Bar yAxisId="left" dataKey="contribution" name="Signed contribution (%)">
                        {data.overall.rows.map((r) => (
                          <Bar key={r.signal} dataKey="contribution" fill={r.contribution_pct >= 0 ? "#22c55e" : "#ef4444"} />
                        ))}
                      </Bar>
                      <Bar yAxisId="right" dataKey="win" name="Win rate (%)" fill="#64748b" opacity={0.6} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 text-xs text-muted-foreground">
                  Suggested prior tilt (used by the AI next tick):{" "}
                  {SIGNALS.map((k) => `${k}=${data.overall.suggested_prior[k].toFixed(0)}`).join(", ")}
                </div>
              </CardContent>
            </Card>

            {/* Cumulative signal contribution over time */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Cumulative signal contribution over time</CardTitle>
              </CardHeader>
              <CardContent>
                {data.cumulative_by_signal.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Not enough evaluable trades in this window yet.</p>
                ) : (
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data.cumulative_by_signal}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="trade_date" stroke="hsl(var(--muted-foreground))" label={{ value: "Trade date", position: "insideBottom", offset: -5, fill: "hsl(var(--muted-foreground))", style: { fontSize: 11 } }} />
                        <YAxis stroke="hsl(var(--muted-foreground))" label={{ value: "Cumulative return contribution (%)", angle: -90, position: "insideLeft", fill: "hsl(var(--muted-foreground))", style: { fontSize: 11 } }} />
                        <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                        <Legend />
                        <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />
                        {SIGNALS.map((k) => (
                          <Line key={k} type="monotone" dataKey={k} stroke={SIGNAL_COLORS[k]} strokeWidth={2} dot={false} />
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
                  <CardTitle className="text-base">News sentiment impact on forward return</CardTitle>
                </CardHeader>
                <CardContent>
                  {data.news_buckets.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No news-scored trades in this window.</p>
                  ) : (
                    <div className="h-60">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={data.news_buckets}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                          <XAxis dataKey="bucket" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 10 }} />
                          <YAxis stroke="hsl(var(--muted-foreground))" label={{ value: "Avg forward return (%)", angle: -90, position: "insideLeft", fill: "hsl(var(--muted-foreground))", style: { fontSize: 11 } }} />
                          <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                          <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />
                          <Bar dataKey="avg_return_pct" name="Avg return (%)" fill="#22c55e" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Scatter of every trade's news_score vs its {horizonDays}-day return follows.
                  </p>
                  {data.trades.some((t) => t.forward_return_pct != null && t.news_score != null) && (
                    <div className="h-56 mt-2">
                      <ResponsiveContainer width="100%" height="100%">
                        <ScatterChart>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                          <XAxis type="number" dataKey="news_score" name="News score" domain={[-1, 1]} stroke="hsl(var(--muted-foreground))" label={{ value: "News score (-1..+1)", position: "insideBottom", offset: -5, fill: "hsl(var(--muted-foreground))", style: { fontSize: 11 } }} />
                          <YAxis type="number" dataKey="forward_return_pct" name="Return (%)" stroke="hsl(var(--muted-foreground))" label={{ value: "Forward return (%)", angle: -90, position: "insideLeft", fill: "hsl(var(--muted-foreground))", style: { fontSize: 11 } }} />
                          <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                          <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />
                          <Scatter
                            data={data.trades.filter((t) => t.forward_return_pct != null && t.news_score != null).map((t) => ({
                              news_score: t.news_score,
                              forward_return_pct: t.forward_return_pct,
                            }))}
                            fill="#06b6d4"
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
                    <div className="text-xs font-medium mb-1 text-muted-foreground">By regime at trade time</div>
                    {data.regime_breakdown.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No regime-tagged trades.</p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead className="text-xs text-muted-foreground">
                          <tr><th className="text-left py-1">Regime</th><th className="text-right">n</th><th className="text-right">Avg return</th><th className="text-right">Win rate</th></tr>
                        </thead>
                        <tbody>
                          {data.regime_breakdown.map((r) => (
                            <tr key={r.regime} className="border-t border-border/50">
                              <td className="py-1">{r.regime.replace(/_/g, " ")}</td>
                              <td className="text-right">{r.n}</td>
                              <td className={`text-right ${(r.avg_return_pct ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}>{fmtPct(r.avg_return_pct)}</td>
                              <td className="text-right">{fmtRate(r.win_rate)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                  <div>
                    <div className="text-xs font-medium mb-1 text-muted-foreground">By guardrail penalty applied</div>
                    {data.penalty_breakdown.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No penalty-tagged trades.</p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead className="text-xs text-muted-foreground">
                          <tr><th className="text-left py-1">Penalty</th><th className="text-right">n</th><th className="text-right">Avg return</th><th className="text-right">Win rate</th></tr>
                        </thead>
                        <tbody>
                          {data.penalty_breakdown.map((r) => (
                            <tr key={r.bucket} className="border-t border-border/50">
                              <td className="py-1">{r.bucket.replace(/_/g, " ")}</td>
                              <td className="text-right">{r.n}</td>
                              <td className={`text-right ${(r.avg_return_pct ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}>{fmtPct(r.avg_return_pct)}</td>
                              <td className="text-right">{fmtRate(r.win_rate)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <p className="text-xs text-muted-foreground mt-2">
                      "event_*" = pre-trade macro/earnings penalty severity; "cooldown" = post-loss halving; "liquidity" = trimmed to 1% of 20d ADV.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Trade-level table */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Trade-by-trade attribution ({data.trades.length} trades)</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left py-1 pr-2">Date</th>
                      <th className="text-left pr-2">Symbol</th>
                      <th className="text-left pr-2">Side</th>
                      <th className="text-right pr-2">Fwd return</th>
                      <th className="text-right pr-2">News</th>
                      <th className="text-left pr-2">Regime</th>
                      <th className="text-left pr-2">Penalties</th>
                      <th className="text-left">Top signal contrib</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.trades.slice(0, 150).map((t, i) => {
                      const topContrib = SIGNALS
                        .map((k) => ({ k, v: t.signal_contrib[k] }))
                        .filter((x) => Math.abs(x.v) > 0.001)
                        .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
                        .slice(0, 2);
                      const penalties: string[] = [];
                      if (t.event_penalty < 0.99) penalties.push(`event ×${t.event_penalty.toFixed(2)}`);
                      if (t.cooldown_applied) penalties.push("cooldown");
                      if (t.liquidity_capped) penalties.push("liquidity");
                      return (
                        <tr key={i} className="border-t border-border/40">
                          <td className="py-1 pr-2">{t.trade_date}</td>
                          <td className="pr-2 font-mono">{t.symbol}</td>
                          <td className="pr-2">
                            <Badge variant={t.side === "buy" ? "default" : "secondary"}>{t.side}</Badge>
                          </td>
                          <td className={`text-right pr-2 ${(t.forward_return_pct ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}>{fmtPct(t.forward_return_pct)}</td>
                          <td className="text-right pr-2">{t.news_score == null ? "—" : t.news_score.toFixed(2)}</td>
                          <td className="pr-2">{t.regime ?? "—"}</td>
                          <td className="pr-2">{penalties.length ? penalties.join(", ") : <span className="text-muted-foreground">none</span>}</td>
                          <td>
                            {topContrib.length === 0 ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              topContrib.map((x) => (
                                <span key={x.k} className="mr-2" style={{ color: SIGNAL_COLORS[x.k] }}>
                                  {x.k} {x.v >= 0 ? "+" : ""}{x.v.toFixed(2)}%
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
                  <p className="text-xs text-muted-foreground mt-2">Showing 150 most recent of {data.trades.length}.</p>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
