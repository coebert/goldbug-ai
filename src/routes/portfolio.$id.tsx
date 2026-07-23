import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getPortfolio,
  runOneDay,
  runBacktest,
  resetPortfolio,
} from "@/lib/trading.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AppHeader } from "@/components/app-header";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { Slider } from "@/components/ui/slider";
import { ArrowLeft, PlayCircle, RotateCcw, Zap, ChevronDown, ShieldCheck, ShieldAlert, TrendingUp, TrendingDown, Newspaper, Activity } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/portfolio/$id")({
  ssr: false,
  head: ({ params }) => ({
    meta: [
      { title: `Portfolio ${params.id.slice(0, 6)} — Aegis` },
      { name: "description", content: "AI paper trading portfolio dashboard." },
    ],
  }),
  component: PortfolioPage,
});

function PortfolioPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setReady(true);
      setEmail(data.session?.user.email ?? null);
      if (!data.session) navigate({ to: "/auth" });
    });
  }, [navigate]);

  const get = useServerFn(getPortfolio);
  const q = useQuery({
    queryKey: ["portfolio", id],
    queryFn: () => get({ data: { id } }),
    enabled: ready,
  });

  const qc = useQueryClient();
  const runDayFn = useServerFn(runOneDay);
  const runBtFn = useServerFn(runBacktest);
  const resetFn = useServerFn(resetPortfolio);
  const [days, setDays] = useState(7);

  const runDay = useMutation({
    mutationFn: () => runDayFn({ data: { portfolio_id: id } }),
    onSuccess: (r) => {
      toast.success(`AI ran. ${r.executedCount} trade(s) executed.`);
      qc.invalidateQueries({ queryKey: ["portfolio", id] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const runBt = useMutation({
    mutationFn: () => runBtFn({ data: { portfolio_id: id, days } }),
    onSuccess: (r) => {
      toast.success(`Backtest done. Final value ~ ${r.finalValue.toFixed(2)}`);
      qc.invalidateQueries({ queryKey: ["portfolio", id] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const reset = useMutation({
    mutationFn: () => resetFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Portfolio reset");
      qc.invalidateQueries({ queryKey: ["portfolio", id] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const equity = q.data?.equity ?? [];
  const equityData = useMemo(
    () =>
      equity.map((e) => ({
        date: e.snapshot_date as string,
        value: Number(e.total_value),
      })),
    [equity],
  );

  const p = q.data?.portfolio;
  const holdings = q.data?.holdings ?? [];
  const trades = q.data?.trades ?? [];
  const decisions = q.data?.decisions ?? [];

  const holdingsValue = useMemo(() => {
    // Approx: use avg_cost as fallback (real value shown in dashboard when snapshots exist)
    return holdings.reduce((s, h) => s + Number(h.quantity) * Number(h.avg_cost), 0);
  }, [holdings]);

  const totalValue = equityData.length
    ? equityData[equityData.length - 1].value
    : Number(p?.current_cash ?? 0) + holdingsValue;
  const startingCash = Number(p?.starting_cash ?? 0);
  const pnl = totalValue - startingCash;
  const pnlPct = startingCash > 0 ? (pnl / startingCash) * 100 : 0;

  if (!ready) return null;

  return (
    <div className="min-h-screen">
      <AppHeader email={email} />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Link
          to="/"
          className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> All portfolios
        </Link>

        {q.isLoading && <p className="text-muted-foreground">Loading…</p>}
        {p && (
          <>
            <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
                <p className="text-sm text-muted-foreground">
                  {p.currency} {startingCash.toFixed(0)} starting · {p.risk_level} risk · {p.mode}
                </p>
              </div>
              <div className="flex items-baseline gap-3">
                <span className="text-3xl font-semibold tabular-nums">
                  {p.currency} {totalValue.toFixed(2)}
                </span>
                <span
                  className={`text-sm font-medium tabular-nums ${
                    pnl >= 0 ? "text-primary" : "text-destructive"
                  }`}
                >
                  {pnl >= 0 ? "+" : ""}
                  {pnl.toFixed(2)} ({pnlPct.toFixed(2)}%)
                </span>
              </div>
            </div>

            <Card className="mb-6">
              <CardContent className="flex flex-wrap items-center gap-3 py-4">
                <Button
                  onClick={() => runDay.mutate()}
                  disabled={runDay.isPending || runBt.isPending}
                >
                  <Zap className="mr-1 h-4 w-4" />
                  {runDay.isPending ? "Running…" : "Run one day now"}
                </Button>
                <div className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5">
                  <span className="text-xs text-muted-foreground">Backtest days:</span>
                  <div className="w-32">
                    <Slider
                      value={[days]}
                      onValueChange={([v]) => setDays(v)}
                      min={3}
                      max={20}
                      step={1}
                    />
                  </div>
                  <span className="w-6 text-right text-sm tabular-nums">{days}</span>
                </div>
                <Button
                  variant="outline"
                  onClick={() => runBt.mutate()}
                  disabled={runBt.isPending || runDay.isPending}
                >
                  <PlayCircle className="mr-1 h-4 w-4" />
                  {runBt.isPending ? "Backtesting…" : `Run ${days}-day backtest`}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (confirm("Reset to starting cash and delete history?")) reset.mutate();
                  }}
                  disabled={reset.isPending}
                >
                  <RotateCcw className="mr-1 h-4 w-4" /> Reset
                </Button>
                {(runDay.isPending || runBt.isPending) && (
                  <span className="text-xs text-muted-foreground">
                    Fetching prices, reading news, asking the AI…
                  </span>
                )}
              </CardContent>
            </Card>

            <div className="grid gap-4 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="text-base">Equity curve</CardTitle>
                </CardHeader>
                <CardContent className="h-64">
                  {equityData.length < 2 ? (
                    <p className="pt-8 text-center text-sm text-muted-foreground">
                      Run a backtest or the daily AI to see the curve.
                    </p>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={equityData}>
                        <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.2} />
                        <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                        <YAxis
                          domain={["auto", "auto"]}
                          tick={{ fontSize: 11 }}
                          tickFormatter={(v) => `${Number(v).toFixed(0)}`}
                        />
                        <Tooltip
                          contentStyle={{
                            background: "var(--card)",
                            border: "1px solid var(--border)",
                            borderRadius: 8,
                          }}
                          formatter={(v: number) => `${p.currency} ${Number(v).toFixed(2)}`}
                        />
                        <ReferenceLine y={startingCash} stroke="var(--muted-foreground)" strokeDasharray="3 3" />
                        <Line
                          type="monotone"
                          dataKey="value"
                          stroke="var(--primary)"
                          strokeWidth={2}
                          dot={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Holdings</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="mb-3 flex items-baseline justify-between text-sm">
                    <span className="text-muted-foreground">Cash</span>
                    <span className="tabular-nums">
                      {p.currency} {Number(p.current_cash).toFixed(2)}
                    </span>
                  </div>
                  {holdings.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Fully in cash.</p>
                  ) : (
                    <div className="space-y-2 text-sm">
                      {holdings.map((h) => (
                        <div key={h.id} className="flex items-baseline justify-between">
                          <div>
                            <div className="font-medium">{h.symbol}</div>
                            <div className="text-xs text-muted-foreground">
                              {Number(h.quantity).toFixed(4)} @ {Number(h.avg_cost).toFixed(2)}
                            </div>
                          </div>
                          <span className="tabular-nums">
                            {(Number(h.quantity) * Number(h.avg_cost)).toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            <Tabs defaultValue="journal" className="mt-6">
              <TabsList>
                <TabsTrigger value="journal">AI Journal ({decisions.length})</TabsTrigger>
                <TabsTrigger value="trades">Trades ({trades.length})</TabsTrigger>
              </TabsList>
              <TabsContent value="journal" className="space-y-4">
                {decisions.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No AI decisions yet. Run one day or a backtest to see the AI's reasoning here.
                  </p>
                )}
                {decisions.map((d) => (
                  <DecisionCard key={d.id} decision={d} currency={p.currency} />
                ))}
              </TabsContent>
              <TabsContent value="trades">
                {trades.length === 0 && (
                  <p className="text-sm text-muted-foreground">No trades yet.</p>
                )}
                {trades.length > 0 && (
                  <div className="overflow-hidden rounded-lg border border-border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/30 text-xs uppercase text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 text-left">Date</th>
                          <th className="px-3 py-2 text-left">Symbol</th>
                          <th className="px-3 py-2 text-left">Side</th>
                          <th className="px-3 py-2 text-right">Qty</th>
                          <th className="px-3 py-2 text-right">Price</th>
                          <th className="px-3 py-2 text-right">Value</th>
                          <th className="px-3 py-2 text-left">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trades.map((t) => (
                          <tr key={t.id} className="border-t border-border">
                            <td className="px-3 py-2 tabular-nums">{t.trade_date}</td>
                            <td className="px-3 py-2 font-medium">{t.symbol}</td>
                            <td
                              className={`px-3 py-2 ${
                                t.side === "buy" ? "text-primary" : "text-accent"
                              }`}
                            >
                              {t.side.toUpperCase()}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {Number(t.quantity).toFixed(4)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {Number(t.price).toFixed(2)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {Number(t.value).toFixed(2)}
                            </td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">{t.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </>
        )}
      </main>
    </div>
  );
}
