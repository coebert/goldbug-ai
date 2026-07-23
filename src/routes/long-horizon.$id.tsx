import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getPortfolio, runLongHorizonBacktest } from "@/lib/trading.functions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppHeader } from "@/components/app-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { CalendarClock, PlayCircle } from "lucide-react";
import { EventOverlay, EventOverlayControls } from "@/components/event-overlay";
import { eventsInRange, eventColor } from "@/lib/global-events";

export const Route = createFileRoute("/long-horizon/$id")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Long-horizon backtest — Aegis" },
      {
        name: "description",
        content:
          "Run a 10–50 year rule-based backtest of the AI strategy against benchmarks (SPY, 60/40, Gold) with regime-specific performance.",
      },
    ],
  }),
  component: LongHorizonPage,
});

type LHResult = Awaited<ReturnType<typeof runLongHorizonBacktest>>;

const PRESETS: Array<{ label: string; from: string; to: string }> = [
  { label: "Since 2000 (dot-com to today)", from: "2000-01-01", to: new Date().toISOString().slice(0, 10) },
  { label: "Since 2005 (GFC era)", from: "2005-01-01", to: new Date().toISOString().slice(0, 10) },
  { label: "Since 2010 (post-GFC)", from: "2010-01-01", to: new Date().toISOString().slice(0, 10) },
  { label: "Since 2015 (10y)", from: "2015-01-01", to: new Date().toISOString().slice(0, 10) },
  { label: "1995 → 2010 (dot-com + GFC)", from: "1995-01-01", to: "2010-12-31" },
];

function fmtPct(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}
function fmtMoney(n: number, currency: string) {
  return `${currency} ${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function LongHorizonPage() {
  const navigate = useNavigate();
  const { id } = useParams({ from: "/long-horizon/$id" });
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]>(null);
  const [ready, setReady] = useState(false);

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

  const getP = useServerFn(getPortfolio);
  const runLH = useServerFn(runLongHorizonBacktest);

  const pQ = useQuery({
    queryKey: ["portfolio", id],
    queryFn: () => getP({ data: { id } }),
    enabled: !!session,
  });

  const [from, setFrom] = useState("2000-01-01");
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [rebalance, setRebalance] = useState<"monthly" | "quarterly">("monthly");
  const [topK, setTopK] = useState(6);
  const [commissionBps, setCommissionBps] = useState(5);
  const [slippageBps, setSlippageBps] = useState(10);
  const [minTradeValue, setMinTradeValue] = useState(25);
  const [result, setResult] = useState<LHResult | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [eventsOn, setEventsOn] = useState(true);
  const [eventSev, setEventSev] = useState<1 | 2 | 3>(2);

  const runMut = useMutation({
    mutationFn: () =>
      runLH({
        data: {
          portfolio_id: id,
          from,
          to,
          rebalance,
          top_k: topK,
          commission_bps: commissionBps,
          slippage_bps: slippageBps,
          min_trade_value: minTradeValue,
        },
      }),
    onSuccess: (r) => {
      setResult(r);
      toast.success(`Simulated ${r.series[0]?.metrics.days ?? 0} trading days, ${r.tradeCount} trades`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Backtest failed"),
  });

  const chartData = useMemo(() => {
    if (!result) return [];
    const start = result.starting_cash;
    // Downsample very large curves so recharts stays responsive: keep ~600 points max.
    const maxPoints = 600;
    const s0 = result.series[0]?.curve ?? [];
    const step = Math.max(1, Math.floor(s0.length / maxPoints));
    const dates = s0.filter((_, i) => i % step === 0 || i === s0.length - 1).map((p) => p.date);
    return dates.map((d) => {
      const row: Record<string, number | string> = { date: d };
      for (const s of result.series) {
        const pt = s.curve.find((p) => p.date === d);
        if (pt) row[s.name] = ((pt.value - start) / start) * 100;
      }
      return row;
    });
  }, [result]);

  if (!ready || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  const portfolio = pQ.data?.portfolio;

  return (
    <div className="min-h-screen">
      <AppHeader email={session.user.email} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <CalendarClock className="h-6 w-6 text-primary" /> Long-horizon backtest
            </h1>
            <p className="text-sm text-muted-foreground">
              {portfolio ? (
                <>
                  <span className="font-medium">{portfolio.name}</span> · {portfolio.currency}{" "}
                  {Number(portfolio.starting_cash).toFixed(0)} · {portfolio.risk_level}
                </>
              ) : (
                "Loading portfolio…"
              )}
            </p>
          </div>
          <Link to="/portfolio/$id" params={{ id }}>
            <Button variant="outline" size="sm">Back to portfolio</Button>
          </Link>
        </div>

        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Configure run</CardTitle>
              <CardDescription>
                Rule-based simulator using the same signals & risk config as the AI engine — no LLM calls, so long horizons run quickly.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label className="text-xs">Preset windows</Label>
                <div className="mt-1 flex flex-col gap-1">
                  {PRESETS.map((p) => (
                    <button
                      key={p.label}
                      className="rounded-md border border-border/60 px-2 py-1.5 text-left text-xs hover:bg-muted/40"
                      onClick={() => { setFrom(p.from); setTo(p.to); }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor="from" className="text-xs">From</Label>
                  <Input id="from" type="date" value={from} min="1975-01-01" onChange={(e) => setFrom(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="to" className="text-xs">To</Label>
                  <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
              </div>

              <div>
                <Label className="text-xs">Rebalance frequency</Label>
                <Select value={rebalance} onValueChange={(v) => setRebalance(v as "monthly" | "quarterly")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="topK" className="text-xs">Top-K holdings ({topK})</Label>
                <Input
                  id="topK"
                  type="number"
                  min={2}
                  max={12}
                  value={topK}
                  onChange={(e) => setTopK(Math.max(2, Math.min(12, Number(e.target.value) || 6)))}
                />
              </div>

              <Button className="w-full" disabled={runMut.isPending} onClick={() => runMut.mutate()}>
                <PlayCircle className="mr-2 h-4 w-4" />
                {runMut.isPending ? "Running…" : "Run backtest"}
              </Button>
              {runMut.isPending && (
                <p className="text-xs text-muted-foreground">
                  First run for a wide window fetches decades of price data from Yahoo and caches it. Subsequent runs are much faster.
                </p>
              )}
            </CardContent>
          </Card>

          <div className="space-y-6">
            {!result && (
              <Card>
                <CardContent className="flex h-64 items-center justify-center text-sm text-muted-foreground">
                  Pick a window and press <span className="mx-1 font-medium text-foreground">Run backtest</span> to compare the Aegis strategy against benchmarks.
                </CardContent>
              </Card>
            )}

            {result && (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center justify-between gap-2">
                      <span>Equity curves (% return, normalised)</span>
                      {focused && (
                        <Button variant="ghost" size="sm" onClick={() => setFocused(null)}>
                          Show all
                        </Button>
                      )}
                    </CardTitle>
                    <CardDescription>
                      {result.from} → {result.to} · {result.rebalance} rebalance · {result.tradeCount} trades executed · click a legend item to isolate.
                    </CardDescription>
                    <div className="mt-2">
                      <EventOverlayControls
                        domainDates={chartData.map((d) => String(d.date))}
                        enabled={eventsOn}
                        onToggle={setEventsOn}
                        minSeverity={eventSev}
                        onSeverityChange={setEventSev}
                      />
                    </div>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={360}>
                      <LineChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                        <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={11} minTickGap={40} />
                        <YAxis
                          stroke="hsl(var(--muted-foreground))"
                          fontSize={11}
                          tickFormatter={(v) => `${Number(v).toFixed(0)}%`}
                        />
                        <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                        {eventsOn && (
                          <EventOverlay
                            domainDates={chartData.map((d) => String(d.date))}
                            minSeverity={eventSev}
                            labelPosition="insideTop"
                          />
                        )}
                        <Tooltip
                          cursor={{ stroke: "hsl(var(--muted-foreground))", strokeDasharray: "3 3" }}
                          content={({ active, payload, label }) => {
                            if (!active || !payload?.length) return null;
                            const sorted = [...payload].sort(
                              (a, b) => Number(b.value ?? 0) - Number(a.value ?? 0),
                            );
                            const active_events = eventsOn
                              ? eventsInRange(String(label), String(label)).filter((e) => e.severity >= eventSev)
                              : [];
                            return (
                              <div className="rounded-md border border-border bg-card p-2 text-xs shadow-md">
                                <div className="mb-1 font-medium">{label}</div>
                                {sorted.map((pt) => {
                                  const val = Number(pt.value ?? 0);
                                  return (
                                    <div key={String(pt.dataKey)} className="flex items-center gap-2 tabular-nums">
                                      <span className="inline-block h-2 w-2 rounded-sm" style={{ background: pt.color }} />
                                      <span className="flex-1">{pt.dataKey}</span>
                                      <span className={val >= 0 ? "text-primary" : "text-destructive"}>{fmtPct(val)}</span>
                                    </div>
                                  );
                                })}
                                {active_events.length > 0 && (
                                  <div className="mt-1 border-t border-border/60 pt-1">
                                    {active_events.map((e) => (
                                      <div key={e.id} style={{ color: eventColor(e.category) }} className="font-medium">
                                        ● {e.label}
                                      </div>
                                    ))}
                                  </div>
                                )}
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
                            <span style={{ opacity: !focused || focused === value ? 1 : 0.35, textDecoration: focused === value ? "underline" : "none" }}>
                              {value}
                            </span>
                          )}
                        />
                        {result.series.map((s) => {
                          const isDim = focused !== null && focused !== s.name;
                          return (
                            <Line
                              key={s.key}
                              type="monotone"
                              dataKey={s.name}
                              stroke={s.color}
                              strokeWidth={focused === s.name ? 3 : s.key === "aegis" ? 2.5 : 1.5}
                              strokeOpacity={isDim ? 0.15 : 1}
                              dot={false}
                              connectNulls
                              isAnimationActive={false}
                            />
                          );
                        })}
                      </LineChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Overall performance vs benchmarks</CardTitle>
                    <CardDescription>Full window: {result.from} → {result.to}</CardDescription>
                  </CardHeader>
                  <CardContent className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-xs uppercase text-muted-foreground">
                        <tr className="border-b border-border/60">
                          <th className="py-2 pr-4 text-left">Strategy</th>
                          <th className="py-2 pr-4 text-right">Final</th>
                          <th className="py-2 pr-4 text-right">Total return</th>
                          <th className="py-2 pr-4 text-right">CAGR</th>
                          <th className="py-2 pr-4 text-right">Max drawdown</th>
                          <th className="py-2 pr-4 text-right">Sharpe</th>
                          <th className="py-2 pr-4 text-right">Volatility</th>
                        </tr>
                      </thead>
                      <tbody className="tabular-nums">
                        {result.series.map((s) => (
                          <tr key={s.key} className={`border-b border-border/40 ${s.key === "aegis" ? "font-medium" : ""}`}>
                            <td className="py-2 pr-4 text-left">
                              <span className="inline-block h-2 w-2 rounded-sm align-middle mr-2" style={{ background: s.color }} />
                              {s.name}
                            </td>
                            <td className="py-2 pr-4 text-right">{fmtMoney(s.metrics.endValue, result.currency)}</td>
                            <td className={`py-2 pr-4 text-right ${s.metrics.totalReturnPct >= 0 ? "text-primary" : "text-destructive"}`}>{fmtPct(s.metrics.totalReturnPct)}</td>
                            <td className="py-2 pr-4 text-right">{fmtPct(s.metrics.cagrPct)}</td>
                            <td className="py-2 pr-4 text-right text-destructive">{s.metrics.maxDrawdownPct.toFixed(1)}%</td>
                            <td className="py-2 pr-4 text-right">{s.metrics.sharpe.toFixed(2)}</td>
                            <td className="py-2 pr-4 text-right">{s.metrics.volatilityPct.toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Regime-specific results</CardTitle>
                    <CardDescription>
                      Same strategy sliced into notable historical regimes from the playbook. "—" means insufficient data in that window.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    {result.regimes.length === 0 && (
                      <p className="text-sm text-muted-foreground">No regime windows fall inside {result.from} → {result.to}.</p>
                    )}
                    {result.regimes.map((reg) => {
                      const aegis = reg.rows.find((r) => r.seriesKey === "aegis");
                      const spy = reg.rows.find((r) => r.seriesKey === "spy");
                      const alpha = aegis && spy ? aegis.metrics.totalReturnPct - spy.metrics.totalReturnPct : null;
                      const kindColor: Record<string, string> = {
                        bull: "bg-primary/20 text-primary",
                        bear: "bg-destructive/20 text-destructive",
                        shock: "bg-amber-500/20 text-amber-400",
                        recovery: "bg-emerald-500/20 text-emerald-400",
                        sideways: "bg-muted text-muted-foreground",
                      };
                      return (
                        <div key={reg.key} className="rounded-md border border-border/60 p-3">
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <span className={`rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${kindColor[reg.kind] ?? "bg-muted"}`}>
                              {reg.kind}
                            </span>
                            <span className="font-medium">{reg.name}</span>
                            <span className="text-xs text-muted-foreground">{reg.from} → {reg.to}</span>
                            {alpha != null && (
                              <span className={`ml-auto text-xs ${alpha >= 0 ? "text-primary" : "text-destructive"}`}>
                                Aegis vs SPY: {fmtPct(alpha)}
                              </span>
                            )}
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead className="text-muted-foreground">
                                <tr>
                                  <th className="py-1 pr-3 text-left">Strategy</th>
                                  <th className="py-1 pr-3 text-right">Return</th>
                                  <th className="py-1 pr-3 text-right">Max DD</th>
                                  <th className="py-1 pr-3 text-right">Sharpe</th>
                                  <th className="py-1 pr-3 text-right">Vol</th>
                                </tr>
                              </thead>
                              <tbody className="tabular-nums">
                                {reg.rows.map((r) => (
                                  <tr key={r.seriesKey} className={r.seriesKey === "aegis" ? "font-medium" : ""}>
                                    <td className="py-1 pr-3">{r.name}</td>
                                    <td className={`py-1 pr-3 text-right ${r.metrics.totalReturnPct >= 0 ? "text-primary" : "text-destructive"}`}>{fmtPct(r.metrics.totalReturnPct)}</td>
                                    <td className="py-1 pr-3 text-right text-destructive">{r.metrics.maxDrawdownPct.toFixed(1)}%</td>
                                    <td className="py-1 pr-3 text-right">{r.metrics.sharpe.toFixed(2)}</td>
                                    <td className="py-1 pr-3 text-right">{r.metrics.volatilityPct.toFixed(1)}%</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
