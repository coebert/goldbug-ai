import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listPortfolios,
  getComparison,
  getTradeComparison,
  runBacktestMany,
} from "@/lib/trading.functions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppHeader } from "@/components/app-header";
import { toast } from "sonner";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { GitCompareArrows, PlayCircle, RefreshCw } from "lucide-react";

export const Route = createFileRoute("/compare")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Compare Portfolios — Aegis" },
      {
        name: "description",
        content:
          "Compare AI paper-trading portfolios side by side: equity curves, drawdown, Sharpe ratio and volatility.",
      },
    ],
  }),
  component: ComparePage,
});

const COLORS = ["#22d3ee", "#a78bfa", "#f472b6", "#facc15", "#4ade80", "#fb923c"];

type ComparisonResult = Awaited<ReturnType<typeof getComparison>>["results"][number];

function ComparePage() {
  const navigate = useNavigate();
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]>(null);
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [days, setDays] = useState(10);
  const [results, setResults] = useState<ComparisonResult[] | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
      if (!data.session) navigate({ to: "/auth" });
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (!s) navigate({ to: "/auth" });
    });
    return () => data.subscription.unsubscribe();
  }, [navigate]);

  const list = useServerFn(listPortfolios);
  const compare = useServerFn(getComparison);
  const runMany = useServerFn(runBacktestMany);

  const portfoliosQ = useQuery({
    queryKey: ["portfolios"],
    queryFn: () => list(),
    enabled: !!session,
  });

  const compareMut = useMutation({
    mutationFn: () => compare({ data: { portfolio_ids: selected } }),
    onSuccess: (r) => setResults(r.results),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const runMut = useMutation({
    mutationFn: () => runMany({ data: { portfolio_ids: selected, days } }),
    onSuccess: async () => {
      toast.success("Backtests complete");
      const r = await compare({ data: { portfolio_ids: selected } });
      setResults(r.results);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= 6 ? prev : [...prev, id],
    );

  const [focused, setFocused] = useState<string | null>(null);

  const { chartData, drawdownData } = useMemo(() => {
    if (!results || results.length === 0) return { chartData: [], drawdownData: [] };
    const dateSet = new Set<string>();
    results.forEach((r) => r.series.forEach((s) => dateSet.add(s.snapshot_date)));
    const dates = Array.from(dateSet).sort();

    // Track running peak per portfolio for drawdown
    const peaks: Record<string, number> = {};
    const chart: Record<string, number | string>[] = [];
    const dd: Record<string, number | string>[] = [];
    for (const d of dates) {
      const row: Record<string, number | string> = { date: d };
      const ddRow: Record<string, number | string> = { date: d };
      for (const r of results) {
        const point = r.series.find((s) => s.snapshot_date === d);
        if (point) {
          const pct = ((point.total_value - r.portfolio.starting_cash) / r.portfolio.starting_cash) * 100;
          row[r.portfolio.name] = pct;
          peaks[r.portfolio.name] = Math.max(peaks[r.portfolio.name] ?? -Infinity, point.total_value);
          const drawdownPct = peaks[r.portfolio.name] > 0
            ? ((point.total_value - peaks[r.portfolio.name]) / peaks[r.portfolio.name]) * 100
            : 0;
          ddRow[r.portfolio.name] = drawdownPct;
        }
      }
      chart.push(row);
      dd.push(ddRow);
    }
    return { chartData: chart, drawdownData: dd };
  }, [results]);

  if (!ready || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  const portfolios = portfoliosQ.data ?? [];

  return (
    <div className="min-h-screen">
      <AppHeader email={session.user.email} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <GitCompareArrows className="h-6 w-6 text-primary" /> Compare portfolios
            </h1>
            <p className="text-sm text-muted-foreground">
              Select up to 6 portfolios, run backtests on the same date range, and compare equity curves and risk-adjusted metrics.
            </p>
          </div>
          <Link to="/">
            <Button variant="outline" size="sm">Back to portfolios</Button>
          </Link>
        </div>

        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Select portfolios</CardTitle>
              <CardDescription>{selected.length}/6 selected</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {portfolios.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No portfolios yet. Create some first.
                </p>
              )}
              {portfolios.map((p) => (
                <label key={p.id} className="flex cursor-pointer items-start gap-2 rounded-md border border-border/60 p-2 text-sm hover:bg-muted/40">
                  <Checkbox
                    checked={selected.includes(p.id)}
                    onCheckedChange={() => toggle(p.id)}
                  />
                  <div className="flex-1">
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.currency} {Number(p.starting_cash).toFixed(0)} · {p.risk_level} · {(p.universe as string[]).join(", ")}
                    </div>
                  </div>
                </label>
              ))}

              <div className="border-t border-border pt-3">
                <Label htmlFor="days" className="text-xs">Backtest window (trading days)</Label>
                <Input
                  id="days"
                  type="number"
                  min={3}
                  max={30}
                  value={days}
                  onChange={(e) => setDays(Math.max(3, Math.min(30, Number(e.target.value) || 10)))}
                />
              </div>

              <div className="space-y-2 pt-1">
                <Button
                  className="w-full"
                  disabled={selected.length === 0 || compareMut.isPending}
                  onClick={() => compareMut.mutate()}
                  variant="outline"
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {compareMut.isPending ? "Loading…" : "Compare existing results"}
                </Button>
                <Button
                  className="w-full"
                  disabled={selected.length === 0 || runMut.isPending}
                  onClick={() => {
                    if (
                      confirm(
                        `This will RESET and re-run ${selected.length} portfolio(s) over ${days} days. Continue?`,
                      )
                    )
                      runMut.mutate();
                  }}
                >
                  <PlayCircle className="mr-2 h-4 w-4" />
                  {runMut.isPending ? "Running backtests…" : "Run backtests & compare"}
                </Button>
                {runMut.isPending && (
                  <p className="text-xs text-muted-foreground">
                    Each portfolio simulates {days} days — this can take a couple of minutes.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center justify-between gap-2">
                  <span>Equity curves (% return)</span>
                  {focused && (
                    <Button variant="ghost" size="sm" onClick={() => setFocused(null)}>
                      Show all
                    </Button>
                  )}
                </CardTitle>
                <CardDescription>
                  Normalised to starting pot. Click a legend item to isolate one line; click again to reset.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!results && (
                  <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
                    Select portfolios and press Compare to see results.
                  </div>
                )}
                {results && chartData.length === 0 && (
                  <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
                    No equity snapshots yet. Run backtests first.
                  </div>
                )}
                {results && chartData.length > 0 && (
                  <>
                    <ResponsiveContainer width="100%" height={320}>
                      <LineChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                        <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                        <YAxis
                          stroke="hsl(var(--muted-foreground))"
                          fontSize={11}
                          tickFormatter={(v) => `${Number(v).toFixed(1)}%`}
                        />
                        <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                        <Tooltip
                          cursor={{ stroke: "hsl(var(--muted-foreground))", strokeDasharray: "3 3" }}
                          content={({ active, payload, label }) => {
                            if (!active || !payload?.length) return null;
                            const sorted = [...payload].sort(
                              (a, b) => Number(b.value ?? 0) - Number(a.value ?? 0),
                            );
                            return (
                              <div className="rounded-md border border-border bg-card p-2 text-xs shadow-md">
                                <div className="mb-1 font-medium">{label}</div>
                                {sorted.map((pt) => {
                                  const val = Number(pt.value ?? 0);
                                  return (
                                    <div
                                      key={String(pt.dataKey)}
                                      className="flex items-center gap-2 tabular-nums"
                                    >
                                      <span
                                        className="inline-block h-2 w-2 rounded-sm"
                                        style={{ background: pt.color }}
                                      />
                                      <span className="flex-1">{pt.dataKey}</span>
                                      <span className={val >= 0 ? "text-primary" : "text-destructive"}>
                                        {val >= 0 ? "+" : ""}
                                        {val.toFixed(2)}%
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          }}
                        />
                        <Legend
                          wrapperStyle={{ fontSize: 12, cursor: "pointer" }}
                          onClick={(o) => {
                            const dk = (o as { dataKey?: unknown }).dataKey;
                            const key = typeof dk === "string" ? dk : String(dk ?? "");
                            setFocused((prev) => (prev === key ? null : key));
                          }}
                          formatter={(value) => (
                            <span
                              style={{
                                opacity: !focused || focused === value ? 1 : 0.35,
                                textDecoration: focused === value ? "underline" : "none",
                              }}
                            >
                              {value}
                            </span>
                          )}
                        />
                        {results.map((r, i) => {
                          const isDim = focused !== null && focused !== r.portfolio.name;
                          return (
                            <Line
                              key={r.portfolio.id}
                              type="monotone"
                              dataKey={r.portfolio.name}
                              stroke={COLORS[i % COLORS.length]}
                              strokeWidth={focused === r.portfolio.name ? 3 : 2}
                              strokeOpacity={isDim ? 0.15 : 1}
                              dot={false}
                              activeDot={isDim ? false : { r: 4 }}
                              connectNulls
                              isAnimationActive={false}
                            />
                          );
                        })}
                      </LineChart>
                    </ResponsiveContainer>

                    <div className="mt-6">
                      <div className="mb-2 text-xs font-medium text-muted-foreground">
                        Drawdown (% below running peak)
                      </div>
                      <ResponsiveContainer width="100%" height={180}>
                        <LineChart data={drawdownData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                          <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                          <YAxis
                            stroke="hsl(var(--muted-foreground))"
                            fontSize={11}
                            tickFormatter={(v) => `${Number(v).toFixed(1)}%`}
                          />
                          <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                          <Tooltip
                            cursor={{ stroke: "hsl(var(--muted-foreground))", strokeDasharray: "3 3" }}
                            contentStyle={{
                              background: "hsl(var(--card))",
                              border: "1px solid hsl(var(--border))",
                              borderRadius: 6,
                              fontSize: 12,
                            }}
                            formatter={(v: number) => `${Number(v).toFixed(2)}%`}
                          />
                          {results.map((r, i) => {
                            const isDim = focused !== null && focused !== r.portfolio.name;
                            return (
                              <Line
                                key={r.portfolio.id}
                                type="monotone"
                                dataKey={r.portfolio.name}
                                stroke={COLORS[i % COLORS.length]}
                                strokeWidth={focused === r.portfolio.name ? 2.5 : 1.5}
                                strokeOpacity={isDim ? 0.12 : 0.9}
                                dot={false}
                                connectNulls
                                isAnimationActive={false}
                              />
                            );
                          })}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {results && results.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Metrics</CardTitle>
                  <CardDescription>
                    Sharpe and volatility annualised (~252 trading days). Drawdown is worst peak-to-trough.
                  </CardDescription>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2 pr-3">Portfolio</th>
                        <th className="py-2 pr-3">Risk</th>
                        <th className="py-2 pr-3 text-right">Days</th>
                        <th className="py-2 pr-3 text-right">Return</th>
                        <th className="py-2 pr-3 text-right">Max DD</th>
                        <th className="py-2 pr-3 text-right">Sharpe</th>
                        <th className="py-2 pr-3 text-right">Vol</th>
                        <th className="py-2 pr-3 text-right">Best day</th>
                        <th className="py-2 pr-3 text-right">Worst day</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((r, i) => {
                        const m = r.metrics;
                        return (
                          <tr key={r.portfolio.id} className="border-b border-border/60">
                            <td className="py-2 pr-3">
                              <span
                                className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
                                style={{ background: COLORS[i % COLORS.length] }}
                              />
                              <Link
                                to="/portfolio/$id"
                                params={{ id: r.portfolio.id }}
                                className="hover:underline"
                              >
                                {r.portfolio.name}
                              </Link>
                            </td>
                            <td className="py-2 pr-3 capitalize text-muted-foreground">{r.portfolio.risk_level}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{m.days}</td>
                            <td className={`py-2 pr-3 text-right tabular-nums ${m.totalReturnPct >= 0 ? "text-primary" : "text-destructive"}`}>
                              {m.totalReturnPct >= 0 ? "+" : ""}{m.totalReturnPct.toFixed(2)}%
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums text-destructive">
                              {m.maxDrawdownPct.toFixed(2)}%
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums">{m.sharpe.toFixed(2)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{m.volatilityPct.toFixed(1)}%</td>
                            <td className="py-2 pr-3 text-right tabular-nums text-primary">
                              +{m.bestDayPct.toFixed(2)}%
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums text-destructive">
                              {m.worstDayPct.toFixed(2)}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
