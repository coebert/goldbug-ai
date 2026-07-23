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
  getBenchmarkSeries,
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
  Line,
  Area,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { Slider } from "@/components/ui/slider";
import { ArrowLeft, PlayCircle, RotateCcw, Zap, ChevronDown, ShieldCheck, ShieldAlert, TrendingUp, TrendingDown, Newspaper, Activity, CalendarClock } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { RiskControlsCard } from "@/components/risk-controls-card";
import { ExecutionCalibrationCard } from "@/components/execution-calibration-card";
import { DiagnosticsPanel } from "@/components/diagnostics-panel";
import { ModeBadge } from "@/components/mode-badge";
import { LiveToggle } from "@/components/live-toggle";
import { Tooltip as UITooltip, TooltipContent as UITooltipContent, TooltipProvider as UITooltipProvider, TooltipTrigger as UITooltipTrigger } from "@/components/ui/tooltip";
import { RegimePanel } from "@/components/regime-panel";
import { LearningPanel } from "@/components/learning-panel";
import { LiveTradingCard } from "@/components/live-trading-card";
import { EventOverlay, EventOverlayControls } from "@/components/event-overlay";
import { eventsInRange, eventColor } from "@/lib/global-events";
import { Explain, ExplainIcon } from "@/components/explain";
import type { TermId } from "@/lib/glossary";


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
  const [eventsOn, setEventsOn] = useState(true);
  const [eventSev, setEventSev] = useState<1 | 2 | 3>(2);
  const [benchmark, setBenchmark] = useState<string>("SPY");
  const [compareMode, setCompareMode] = useState<"raw" | "pct">(() => {
    if (typeof window === "undefined") return "raw";
    const v = window.localStorage.getItem("aegis.compareMode");
    return v === "pct" ? "pct" : "raw";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("aegis.compareMode", compareMode);
    }
  }, [compareMode]);
  const [chartContrast, setChartContrast] = useState<"standard" | "high" | "light" | "cb">(() => {
    if (typeof window === "undefined") return "standard";
    const v = window.localStorage.getItem("aegis.chartContrast");
    return v === "high" || v === "light" || v === "cb" ? v : "standard";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("aegis.chartContrast", chartContrast);
    }
  }, [chartContrast]);
  const [riskFreeRate, setRiskFreeRate] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    const v = Number(window.localStorage.getItem("aegis.riskFreeRate"));
    return Number.isFinite(v) ? v : 0;
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("aegis.riskFreeRate", String(riskFreeRate));
    }
  }, [riskFreeRate]);
  const chartTheme = useMemo(() => {
    if (chartContrast === "high") {
      return {
        equity: "#7dfcff",
        equityFillTop: 0.55,
        equityFillBottom: 0.05,
        benchmark: "#ffd257",
        drawdown: "#ff6b6b",
        peak: "#e5e7eb",
        gridOpacity: 0.6,
        axis: "#e5e7eb",
        strokeWidth: 3,
        surface: "transparent",
      } as const;
    }
    if (chartContrast === "light") {
      return {
        equity: "#0e7490",
        equityFillTop: 0.35,
        equityFillBottom: 0,
        benchmark: "#b45309",
        drawdown: "#b91c1c",
        peak: "#334155",
        gridOpacity: 0.35,
        axis: "#334155",
        strokeWidth: 2.5,
        surface: "#f8fafc",
      } as const;
    }
    if (chartContrast === "cb") {
      // Okabe–Ito palette: distinguishable across deuteranopia, protanopia, tritanopia.
      // Portfolio = blue (#0072B2), Benchmark = orange (#E69F00),
      // Drawdown = vermillion (#D55E00), Peak/axes = bluish-grey (#CFCFCF).
      return {
        equity: "#56B4E9",
        equityFillTop: 0.5,
        equityFillBottom: 0.05,
        benchmark: "#E69F00",
        drawdown: "#D55E00",
        peak: "#CFCFCF",
        gridOpacity: 0.55,
        axis: "#CFCFCF",
        strokeWidth: 3,
        surface: "transparent",
      } as const;
    }
    return {
      equity: "#22d3ee",
      equityFillTop: 0.35,
      equityFillBottom: 0,
      benchmark: "#f59e0b",
      drawdown: "hsl(var(--destructive))",
      peak: "hsl(var(--muted-foreground))",
      gridOpacity: 0.35,
      axis: "hsl(var(--border))",
      strokeWidth: 2.5,
      surface: "transparent",
    } as const;
  }, [chartContrast]);

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
  const equityData = useMemo(() => {
    let peak = -Infinity;
    return equity.map((e) => {
      const value = Number(e.total_value);
      peak = Math.max(peak, value);
      const drawdown = peak > 0 ? ((value - peak) / peak) * 100 : 0;
      return {
        date: e.snapshot_date as string,
        value,
        peak,
        drawdown, // negative or zero
        underwater: value < peak ? value : null, // for area shading
      };
    });
  }, [equity]);

  const benchFn = useServerFn(getBenchmarkSeries);
  const fromDate = equityData[0]?.date;
  const toDate = equityData[equityData.length - 1]?.date;
  const benchQ = useQuery({
    queryKey: ["benchmark", benchmark, fromDate, toDate],
    queryFn: () => benchFn({ data: { symbol: benchmark, from: fromDate!, to: toDate! } }),
    enabled: benchmark !== "none" && !!fromDate && !!toDate && equityData.length >= 2,
    staleTime: 5 * 60 * 1000,
  });

  const startingCashForChart = Number(q.data?.portfolio?.starting_cash ?? 0);
  const chartData = useMemo(() => {
    if (benchmark === "none" || !benchQ.data?.series?.length) return equityData;
    const bmap = new Map(benchQ.data.series.map((r) => [r.date, r.close]));
    // Find first close on/before the first equity date to normalise
    const dates = [...bmap.keys()].sort();
    let base: number | null = null;
    for (const d of dates) {
      if (d <= equityData[0].date) base = bmap.get(d)!;
      else break;
    }
    if (base == null) base = bmap.get(dates[0])!;
    let lastBench: number | null = base;
    return equityData.map((row) => {
      // Latest close on/before this equity date
      for (const d of dates) {
        if (d <= row.date) lastBench = bmap.get(d)!;
        else break;
      }
      const benchmark_value = lastBench != null && base != null
        ? startingCashForChart * (lastBench / base)
        : null;
      return { ...row, benchmark: benchmark_value };
    });
  }, [equityData, benchQ.data, benchmark, startingCashForChart]);

  const displayChartData = useMemo(() => {
    if (compareMode === "raw" || startingCashForChart <= 0) return chartData;
    const base = startingCashForChart;
    return chartData.map((row) => {
      const r = row as typeof row & { benchmark?: number | null };
      return {
        ...row,
        value: ((row.value - base) / base) * 100,
        peak: ((row.peak - base) / base) * 100,
        drawdown: row.drawdown,
        benchmark: r.benchmark != null ? ((r.benchmark - base) / base) * 100 : r.benchmark ?? null,
      };
    });
  }, [chartData, compareMode, startingCashForChart]);

  const perfMetrics = useMemo(() => {
    const rows = chartData.filter((r) => Number.isFinite(r.value));
    if (rows.length < 2) return null;
    const portVals = rows.map((r) => r.value);
    const benchVals = rows.map((r) => (r as { benchmark?: number | null }).benchmark ?? null);
    const hasBench = benchmark !== "none" && benchVals.every((v) => v != null && Number.isFinite(v));

    const dailyReturns = (vals: number[]) => {
      const out: number[] = [];
      for (let i = 1; i < vals.length; i++) {
        const prev = vals[i - 1];
        if (prev > 0) out.push(vals[i] / prev - 1);
      }
      return out;
    };
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const stdev = (xs: number[]) => {
      if (xs.length < 2) return 0;
      const m = mean(xs);
      const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
      return Math.sqrt(v);
    };
    const maxDD = (vals: number[]) => {
      let peak = -Infinity;
      let worst = 0;
      for (const v of vals) {
        peak = Math.max(peak, v);
        if (peak > 0) worst = Math.min(worst, (v - peak) / peak);
      }
      return worst * 100; // negative %
    };
    const compute = (vals: number[]) => {
      const rets = dailyReturns(vals);
      const totalReturn = vals[0] > 0 ? (vals[vals.length - 1] / vals[0] - 1) * 100 : 0;
      const years = Math.max(rets.length / 252, 1 / 252);
      const growth = vals[0] > 0 ? vals[vals.length - 1] / vals[0] : 1;
      const annReturn = (Math.pow(growth, 1 / years) - 1) * 100;
      const annVol = stdev(rets) * Math.sqrt(252) * 100;
      return { totalReturn, annReturn, annVol, maxDrawdown: maxDD(vals), rets };
    };
    const port = compute(portVals);
    const bench = hasBench ? compute(benchVals as number[]) : null;

    let correlation: number | null = null;
    if (bench) {
      const n = Math.min(port.rets.length, bench.rets.length);
      if (n >= 2) {
        const a = port.rets.slice(-n);
        const b = bench.rets.slice(-n);
        const ma = mean(a);
        const mb = mean(b);
        let num = 0;
        let da = 0;
        let db = 0;
        for (let i = 0; i < n; i++) {
          num += (a[i] - ma) * (b[i] - mb);
          da += (a[i] - ma) ** 2;
          db += (b[i] - mb) ** 2;
        }
        const denom = Math.sqrt(da * db);
        correlation = denom > 0 ? num / denom : null;
      }
    }
    return { port, bench, correlation };
  }, [chartData, benchmark]);



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
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
                  <ModeBadge mode={p.mode} />
                </div>
                <p className="text-sm text-muted-foreground">
                  {p.currency} {startingCash.toFixed(0)} <Explain term="starting_pot">starting pot</Explain> · <Explain term="risk_level">{p.risk_level} risk</Explain>
                </p>
                {p.mode === "live_prod" ? (
                  <p className="mt-1 text-xs font-medium text-destructive">
                    ⚠ <Explain term="live_prod">Real money</Explain> — approved orders route to your live broker account.
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    This portfolio uses <span className="font-medium text-foreground">pretend money</span> — nothing you do here touches your bank or Saxo account. {p.mode === "live_sim" ? <>(<Explain term="live_sim">paper-traded against live prices</Explain>)</> : <>(<Explain term="backtest">historical backtest only</Explain>)</>}
                  </p>
                )}
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
                <Link to="/long-horizon/$id" params={{ id }}>
                  <Button variant="outline">
                    <CalendarClock className="mr-1 h-4 w-4" /> Long-horizon backtest
                  </Button>
                </Link>
                {(runDay.isPending || runBt.isPending) && (
                  <span className="text-xs text-muted-foreground">
                    Fetching prices, reading news, asking the AI…
                  </span>
                )}
              </CardContent>
            </Card>

            {(() => {
              const cb = p.circuit_breaker as { paused?: boolean; reason?: string; tripped_at?: string } | null;
              if (!cb?.paused) return null;
              return (
                <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
                  <div className="font-medium text-destructive">Circuit breaker active — AI paused</div>
                  <div className="mt-1 text-muted-foreground">
                    {cb.reason ?? "Auto-paused"}{cb.tripped_at ? ` (since ${cb.tripped_at.slice(0, 10)})` : ""}. Stop-loss/take-profit still enforced. Adjust risk controls or clear the breaker to resume new trades.
                  </div>
                </div>
              );
            })()}

            <div className="mb-6 space-y-4">
              <RiskControlsCard portfolioId={id} riskConfig={p.risk_config} />
              <ExecutionCalibrationCard
                portfolioId={id}
                execParams={(p.risk_config as { execution_params?: Parameters<typeof ExecutionCalibrationCard>[0]["execParams"] } | null)?.execution_params ?? null}
                calibration={(p.risk_config as { execution_calibration?: Parameters<typeof ExecutionCalibrationCard>[0]["calibration"] } | null)?.execution_calibration ?? null}
              />
            </div>


            <div className="mb-6">
              <LiveTradingCard portfolioId={id} />
            </div>

            <div className="grid gap-4 lg:grid-cols-3">

              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="text-base flex flex-wrap items-center justify-between gap-3">
                    <span>Equity curve</span>
                    <div className="flex items-center gap-2">
                      <label className="text-xs font-normal text-muted-foreground">Benchmark</label>
                      <select
                        value={benchmark}
                        onChange={(e) => setBenchmark(e.target.value)}
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs font-normal"
                      >
                        <option value="none">None</option>
                        <option value="SPY">SPY (S&amp;P 500)</option>
                        <option value="QQQ">QQQ (Nasdaq 100)</option>
                        <option value="ACWI">ACWI (Global)</option>
                        <option value="AGG">AGG (US Bonds)</option>
                        <option value="GLD">GLD (Gold)</option>
                        <option value="BTC-USD">BTC-USD</option>
                      </select>
                      <div className="inline-flex overflow-hidden rounded-md border border-border text-xs">
                        {(["standard", "high", "light", "cb"] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setChartContrast(mode)}
                            className={`px-2 py-1 font-normal capitalize transition-colors ${
                              chartContrast === mode
                                ? "bg-primary text-primary-foreground"
                                : "bg-background text-muted-foreground hover:text-foreground"
                            }`}
                            title={mode === "cb" ? "Colorblind-safe palette (Okabe–Ito)" : `${mode} contrast`}
                            aria-label={mode === "cb" ? "Colorblind-safe palette" : `${mode} contrast`}
                          >
                            {mode === "cb" ? "Colorblind" : mode}
                          </button>
                        ))}
                      </div>
                      <label className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground" title="Annual risk-free rate used in Sharpe ratio">
                        <span>Rf</span>
                        <input
                          type="number"
                          step="0.1"
                          value={riskFreeRate}
                          onChange={(e) => setRiskFreeRate(Number(e.target.value) || 0)}
                          className="w-14 bg-transparent text-foreground tabular-nums outline-none"
                          aria-label="Risk-free rate (annual %)"
                        />
                        <span>%</span>
                      </label>
                      <div className="inline-flex overflow-hidden rounded-md border border-border text-xs" role="group" aria-label="Benchmark compare mode">
                        {(["raw", "pct"] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setCompareMode(mode)}
                            className={`px-2 py-1 font-normal transition-colors ${
                              compareMode === mode
                                ? "bg-primary text-primary-foreground"
                                : "bg-background text-muted-foreground hover:text-foreground"
                            }`}
                            title={mode === "pct" ? "Normalized: % indexed to start" : "Raw value"}
                          >
                            {mode === "pct" ? "% vs start" : "Raw"}
                          </button>
                        ))}
                      </div>
                      <EventOverlayControls
                        domainDates={equityData.map((d) => d.date)}
                        enabled={eventsOn}
                        onToggle={setEventsOn}
                        minSeverity={eventSev}
                        onSeverityChange={setEventSev}
                      />
                    </div>
                  </CardTitle>
                </CardHeader>
                {perfMetrics && (
                  <div className="mx-6 mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {([
                      { label: "CAGR", term: "cagr" as TermId, value: perfMetrics.port.annReturn, suffix: "%", signed: true, negative: false },
                      { label: "Volatility (ann.)", term: "volatility" as TermId, value: perfMetrics.port.annVol, suffix: "%", signed: false, negative: false },
                      { label: `Sharpe (rf=${riskFreeRate}%)`, term: "sharpe" as TermId, value: perfMetrics.port.annVol > 0 ? (perfMetrics.port.annReturn - riskFreeRate) / perfMetrics.port.annVol : null, suffix: "", signed: true, negative: false },
                      { label: "Max drawdown", term: "max_drawdown" as TermId, value: perfMetrics.port.maxDrawdown, suffix: "%", signed: false, negative: true },
                    ] as const).map((m) => {
                      const bv = m.label === "CAGR" ? perfMetrics.bench?.annReturn
                        : m.label === "Volatility (ann.)" ? perfMetrics.bench?.annVol
                        : m.label === "Max drawdown" ? perfMetrics.bench?.maxDrawdown
                        : (perfMetrics.bench && perfMetrics.bench.annVol > 0 ? (perfMetrics.bench.annReturn - riskFreeRate) / perfMetrics.bench.annVol : null);
                      const fmt = (v: number | null | undefined) => {
                        if (v == null || !Number.isFinite(v)) return "—";
                        const s = m.signed && v > 0 ? "+" : "";
                        const d = 2;
                        return `${s}${v.toFixed(d)}${m.suffix}`;
                      };
                      const color = (v: number | null | undefined) => {
                        if (v == null) return "text-muted-foreground";
                        if (m.negative) return v < 0 ? "text-destructive" : "text-foreground";
                        if (!m.signed) return "text-foreground";
                        return v >= 0 ? "text-primary" : "text-destructive";
                      };
                      return (
                        <div key={m.label} className="rounded-md border border-border/70 bg-muted/30 p-3">
                          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                            <span>{m.label}</span>
                            <ExplainIcon term={m.term} />
                          </div>
                          <div className={`tabular-nums text-xl font-semibold ${color(m.value)}`}>{fmt(m.value)}</div>
                          {perfMetrics.bench && (
                            <div className="tabular-nums text-[11px] text-muted-foreground">
                              {benchmark}: <span className={color(bv)}>{fmt(bv)}</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {perfMetrics && (
                  <div className="mx-6 mb-3 rounded-md border border-border/70 bg-muted/30 p-3">
                    <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wide text-muted-foreground">
                      <span>Performance vs {benchmark === "none" ? "benchmark" : benchmark}</span>
                      {perfMetrics.correlation != null && (
                        <span className="tabular-nums">
                          Correlation: <span className="font-medium text-foreground">{perfMetrics.correlation.toFixed(2)}</span>
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-5">
                      {([
                        { label: "Total return", key: "totalReturn", suffix: "%", signed: true, negative: false, derived: false },
                        { label: "Annualized return", key: "annReturn", suffix: "%", signed: true, negative: false, derived: false },
                        { label: "Volatility (ann.)", key: "annVol", suffix: "%", signed: false, negative: false, derived: false },
                        { label: "Max drawdown", key: "maxDrawdown", suffix: "%", signed: false, negative: true, derived: false },
                        { label: "Return / Vol", key: "rvr", suffix: "", signed: true, negative: false, derived: true },
                      ] as const).map((m) => {
                        const fmt = (v: number | null | undefined) => {
                          if (v == null || !Number.isFinite(v)) return "—";
                          const s = m.signed && v > 0 ? "+" : "";
                          return `${s}${v.toFixed(2)}${m.suffix}`;
                        };
                        const derived = (obj: { annReturn: number; annVol: number } | null) =>
                          obj && obj.annVol > 0 ? obj.annReturn / obj.annVol : null;
                        const pick = (obj: typeof perfMetrics.port | null) => {
                          if (!obj) return null;
                          const v = (obj as unknown as Record<string, unknown>)[m.key];
                          return typeof v === "number" ? v : null;
                        };
                        const pv = m.derived ? derived(perfMetrics.port) : pick(perfMetrics.port);
                        const bv = m.derived ? derived(perfMetrics.bench) : pick(perfMetrics.bench);
                        const color = (v: number | null) => {
                          if (v == null) return "text-muted-foreground";
                          if (m.negative) return v < 0 ? "text-destructive" : "text-foreground";
                          if (!m.signed) return "text-foreground";
                          return v >= 0 ? "text-primary" : "text-destructive";
                        };
                        return (
                          <div key={m.label} className="min-w-0">
                            <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{m.label}</div>
                            <div className={`tabular-nums font-medium ${color(pv)}`}>
                              {fmt(pv)}
                            </div>
                            {perfMetrics.bench && (
                              <div className="tabular-nums text-[11px] text-muted-foreground">
                                {benchmark}: <span className={color(bv)}>{fmt(bv)}</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                <CardContent
                  className="h-64"
                  style={chartTheme.surface !== "transparent" ? { background: chartTheme.surface, borderRadius: 8 } : undefined}
                >
                  {equityData.length < 2 ? (
                    <p className="pt-8 text-center text-sm text-muted-foreground">
                      Run a backtest or the daily AI to see the curve.
                    </p>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={displayChartData} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                        <defs>
                          <linearGradient id="ddFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={chartTheme.drawdown} stopOpacity={0.28} />
                            <stop offset="100%" stopColor={chartTheme.drawdown} stopOpacity={0.02} />
                          </linearGradient>
                          <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={chartTheme.equity} stopOpacity={chartTheme.equityFillTop} />
                            <stop offset="100%" stopColor={chartTheme.equity} stopOpacity={chartTheme.equityFillBottom} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke={chartTheme.axis} strokeOpacity={chartTheme.gridOpacity} strokeDasharray="3 3" />
                        <XAxis
                          dataKey="date"
                          tick={{ fontSize: 11, fill: chartTheme.axis }}
                          stroke={chartTheme.axis}
                          label={{ value: "Date", position: "insideBottom", offset: -2, fill: chartTheme.axis, fontSize: 12 }}
                        />
                        <YAxis
                          domain={["auto", "auto"]}
                          width={72}
                          tick={{ fontSize: 11, fill: chartTheme.axis }}
                          stroke={chartTheme.axis}
                          tickFormatter={(v) => compareMode === "pct" ? `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(0)}%` : `${p.currency}${Number(v).toFixed(0)}`}
                          label={{ value: compareMode === "pct" ? "Return vs start (%)" : `Portfolio value (${p.currency})`, angle: -90, position: "insideLeft", offset: 8, style: { textAnchor: "middle" }, fill: chartTheme.axis, fontSize: 12 }}
                        />

                        <Tooltip
                          cursor={{ stroke: chartTheme.axis, strokeDasharray: "3 3" }}
                          content={({ active, payload, label }) => {
                            if (!active || !payload?.length) return null;
                            const row = payload[0].payload as {
                              value: number;
                              peak: number;
                              drawdown: number;
                              benchmark?: number | null;
                            };
                            const isPct = compareMode === "pct";
                            const fmtVal = (v: number) => isPct
                              ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`
                              : `${p.currency} ${v.toFixed(2)}`;
                            const pnlFromStart = isPct ? row.value : row.value - startingCash;
                            const pnlPctFromStart = isPct
                              ? row.value
                              : startingCash > 0 ? (pnlFromStart / startingCash) * 100 : 0;
                            const benchPct = row.benchmark == null
                              ? null
                              : isPct
                                ? row.benchmark
                                : startingCash > 0 ? ((row.benchmark - startingCash) / startingCash) * 100 : null;
                            const active_events = eventsOn
                              ? eventsInRange(String(label), String(label)).filter((e) => e.severity >= eventSev)
                              : [];
                            return (
                              <div className="rounded-md border border-border bg-card p-2 text-xs shadow-md">
                                <div className="mb-1 font-medium">
                                  {label} <span className="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground">{isPct ? "% vs start" : "value"}</span>
                                </div>
                                <div className="tabular-nums">
                                  <span className="inline-block h-2 w-2 rounded-full mr-1.5" style={{ background: chartTheme.equity }} />
                                  Portfolio: {fmtVal(row.value)}
                                </div>
                                {!isPct && (
                                  <div className="tabular-nums text-muted-foreground pl-3.5">
                                    vs start: {pnlFromStart >= 0 ? "+" : ""}
                                    {pnlFromStart.toFixed(2)} ({pnlPctFromStart.toFixed(2)}%)
                                  </div>
                                )}
                                {row.benchmark != null && (
                                  <div className="tabular-nums mt-1">
                                    <span className="inline-block h-2 w-2 rounded-full mr-1.5" style={{ background: chartTheme.benchmark }} />
                                    {benchmark}: {fmtVal(row.benchmark)}
                                    {!isPct && benchPct != null && (
                                      <span className="text-muted-foreground"> ({benchPct >= 0 ? "+" : ""}{benchPct.toFixed(2)}%)</span>
                                    )}
                                  </div>
                                )}
                                <div className="tabular-nums text-muted-foreground mt-1">
                                  Peak: {fmtVal(row.peak)}
                                </div>
                                <div className={`tabular-nums ${row.drawdown < 0 ? "text-destructive" : "text-primary"}`}>
                                  Drawdown: {row.drawdown.toFixed(2)}%
                                </div>
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
                        <ReferenceLine y={compareMode === "pct" ? 0 : startingCash} stroke={chartTheme.axis} strokeDasharray="3 3" label={{ value: "start", fill: chartTheme.axis, fontSize: 10, position: "insideTopRight" }} />
                        {eventsOn && (
                          <EventOverlay
                            domainDates={equityData.map((d) => d.date)}
                            minSeverity={eventSev}
                            labelPosition="insideTop"
                          />
                        )}
                        <Area
                          type="monotone"
                          dataKey="peak"
                          stroke="none"
                          fill="url(#ddFill)"
                          fillOpacity={1}
                          isAnimationActive={false}
                          activeDot={false}
                        />
                        <Area
                          type="monotone"
                          dataKey="value"
                          stroke="none"
                          fill="url(#equityFill)"
                          fillOpacity={1}
                          isAnimationActive={false}
                          activeDot={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="peak"
                          stroke={chartTheme.peak}
                          strokeWidth={1}
                          strokeDasharray="2 3"
                          dot={false}
                          isAnimationActive={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="value"
                          name="Portfolio"
                          stroke={chartTheme.equity}
                          strokeWidth={chartTheme.strokeWidth}
                          dot={false}
                          activeDot={{ r: 5, fill: chartTheme.equity, stroke: "hsl(var(--background))", strokeWidth: 2 }}
                        />
                        {benchmark !== "none" && (
                          <Line
                            type="monotone"
                            dataKey="benchmark"
                            name={`${benchmark} (normalised)`}
                            stroke={chartTheme.benchmark}
                            strokeWidth={Math.max(2, chartTheme.strokeWidth - 0.5)}
                            strokeDasharray="4 3"
                            dot={false}
                            connectNulls
                            isAnimationActive={false}
                            activeDot={{ r: 4, fill: chartTheme.benchmark, stroke: "hsl(var(--background))", strokeWidth: 2 }}
                          />
                        )}
                        <Legend
                          verticalAlign="bottom"
                          height={24}
                          iconType="plainline"
                          wrapperStyle={{ fontSize: 11, color: chartTheme.axis }}
                        />
                      </ComposedChart>
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

            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              <RegimePanel />
              <LearningPanel portfolioId={p.id} />
            </div>

            <Tabs defaultValue="journal" className="mt-6">
              <TabsList>
                <TabsTrigger value="journal">AI Journal ({decisions.length})</TabsTrigger>
                <TabsTrigger value="trades">Trades ({trades.length})</TabsTrigger>
                <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
                <TabsTrigger value="attribution" asChild>
                  <Link to="/portfolio/$id/attribution" params={{ id: p.id }}>Attribution</Link>
                </TabsTrigger>
                <TabsTrigger value="report" asChild>
                  <Link to="/portfolio/$id/report" params={{ id: p.id }}>Report</Link>
                </TabsTrigger>
                <TabsTrigger value="optimizer" asChild>
                  <Link to="/portfolio/$id/optimizer" params={{ id: p.id }}>Optimizer</Link>
                </TabsTrigger>
              </TabsList>
              <TabsContent value="diagnostics" className="space-y-4">
                <DiagnosticsPanel portfolioId={p.id} />
              </TabsContent>
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
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full min-w-[640px] text-sm">
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

type SignalRow = {
  symbol: string;
  name: string;
  asset_class: string;
  price: number;
  sma20: number | null;
  sma50: number | null;
  rsi14: number | null;
  change5d: number | null;
  change30d: number | null;
};

type ExecutedRow = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  value: number;
  reason: string;
  rejected?: string;
};

type NewsRow = { headline: string; source: string | null };

type Guardrails = {
  risk_level: string;
  max_position_pct: number;
  cash_floor_pct: number;
  max_new_positions_per_day: number;
  cash_floor_value: number;
  max_position_value: number;
  starting_total_value: number;
  starting_cash: number;
};

type SignalWeights = {
  sma_trend: number;
  rsi: number;
  price_change: number;
  news_sentiment: number;
  volatility: number;
};

type AiOrder = {
  symbol?: string;
  side?: "buy" | "sell";
  signal_weights?: Partial<SignalWeights>;
};

type DecisionRaw = {
  orders?: AiOrder[];
  executed?: ExecutedRow[];
  signals?: SignalRow[];
  news?: NewsRow[];
  guardrails?: Guardrails;
};


function fmtNum(v: number | null | undefined, digits = 2) {
  if (v == null || Number.isNaN(v)) return "—";
  return Number(v).toFixed(digits);
}

function fmtPct(v: number | null | undefined) {
  if (v == null || Number.isNaN(v)) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${(v * 100).toFixed(1)}%`;
}

function keywordMatch(text: string, symbol: string, name: string) {
  const t = text.toLowerCase();
  if (t.includes(symbol.toLowerCase())) return true;
  const first = name.split(/\s+/)[0]?.toLowerCase();
  if (first && first.length > 3 && t.includes(first)) return true;
  return false;
}

function SignalBadges({ s }: { s: SignalRow }) {
  const trendUp = s.sma20 != null && s.sma50 != null && s.sma20 > s.sma50;
  const rsi = s.rsi14;
  return (
    <div className="flex flex-wrap gap-1.5 text-xs">
      <Badge variant="outline" className="tabular-nums">Px {fmtNum(s.price)}</Badge>
      <Badge variant="outline" className="tabular-nums">
        {trendUp ? <TrendingUp className="mr-1 h-3 w-3 text-primary" /> : <TrendingDown className="mr-1 h-3 w-3 text-destructive" />}
        SMA20 {fmtNum(s.sma20)} / 50 {fmtNum(s.sma50)}
      </Badge>
      {rsi != null && (
        <Badge
          variant="outline"
          className={
            rsi >= 70
              ? "text-destructive"
              : rsi <= 30
              ? "text-primary"
              : ""
          }
        >
          RSI {fmtNum(rsi, 0)}
          {rsi >= 70 ? " · overbought" : rsi <= 30 ? " · oversold" : ""}
        </Badge>
      )}
      <Badge variant="outline" className={s.change5d != null && s.change5d >= 0 ? "text-primary" : "text-destructive"}>
        5d {fmtPct(s.change5d)}
      </Badge>
      <Badge variant="outline" className={s.change30d != null && s.change30d >= 0 ? "text-primary" : "text-destructive"}>
        30d {fmtPct(s.change30d)}
      </Badge>
    </div>
  );
}

const SIGNAL_LABELS: Array<{ key: keyof SignalWeights; label: string; color: string }> = [
  { key: "sma_trend", label: "SMA trend", color: "bg-primary" },
  { key: "rsi", label: "RSI", color: "bg-accent" },
  { key: "price_change", label: "Price change", color: "bg-chart-3" },
  { key: "news_sentiment", label: "News sentiment", color: "bg-chart-4" },
  { key: "volatility", label: "Volatility", color: "bg-chart-5" },
];

function normalizeWeights(w: Partial<SignalWeights> | undefined): SignalWeights | null {
  if (!w) return null;
  const vals = SIGNAL_LABELS.map(({ key }) => Number(w[key] ?? 0));
  const total = vals.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const scale = 100 / total;
  return {
    sma_trend: vals[0] * scale,
    rsi: vals[1] * scale,
    price_change: vals[2] * scale,
    news_sentiment: vals[3] * scale,
    volatility: vals[4] * scale,
  };
}

function SignalImportance({ weights }: { weights: SignalWeights }) {
  const ranked = [...SIGNAL_LABELS]
    .map((s) => ({ ...s, value: weights[s.key] }))
    .sort((a, b) => b.value - a.value);
  return (
    <div className="space-y-2">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {ranked.map((s) => (
          <div
            key={s.key}
            className={s.color}
            style={{ width: `${Math.max(0, s.value)}%` }}
            title={`${s.label}: ${s.value.toFixed(0)}%`}
          />
        ))}
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-3">
        {ranked.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5 tabular-nums">
            <span className={`h-2 w-2 rounded-sm ${s.color}`} />
            <span className="text-muted-foreground">{s.label}</span>
            <span className="ml-auto font-medium">{s.value.toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OrderPanel({
  order,
  signal,
  news,
  guardrails,
  currency,
  weights,
}: {
  order: ExecutedRow;
  signal?: SignalRow;
  news: NewsRow[];
  guardrails?: Guardrails;
  currency: string;
  weights?: SignalWeights | null;
}) {
  const approved = !order.rejected;
  const side = order.side;
  const relatedNews = signal
    ? news.filter((n) => keywordMatch(n.headline, signal.symbol, signal.name)).slice(0, 3)
    : [];


  return (
    <div className="rounded-lg border border-border bg-muted/10 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge
            className={
              side === "buy"
                ? "bg-primary/15 text-primary hover:bg-primary/15"
                : "bg-accent/15 text-accent hover:bg-accent/15"
            }
          >
            {side.toUpperCase()}
          </Badge>
          <span className="font-medium">{order.symbol}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {order.quantity > 0
              ? `${fmtNum(order.quantity, 4)} @ ${fmtNum(order.price)} = ${currency} ${fmtNum(order.value)}`
              : `intended · ${currency} ${fmtNum(order.price)}`}
          </span>
        </div>
        {approved ? (
          <Badge variant="outline" className="border-primary/40 text-primary">
            <ShieldCheck className="mr-1 h-3 w-3" /> Guardrails passed
          </Badge>
        ) : (
          <Badge variant="outline" className="border-destructive/40 text-destructive">
            <ShieldAlert className="mr-1 h-3 w-3" /> Blocked · {order.rejected}
          </Badge>
        )}
      </div>

      <p className="mb-2 text-sm">
        <span className="text-muted-foreground">AI reason: </span>
        {order.reason}
      </p>

      {weights && (
        <div className="mb-3">
          <div className="mb-1.5 flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground">
            <Activity className="h-3 w-3" /> Signal importance (AI-attributed)
          </div>
          <SignalImportance weights={weights} />
        </div>
      )}

      {signal && (
        <div className="mb-2">
          <div className="mb-1 flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground">
            <Activity className="h-3 w-3" /> Signals driving this call
          </div>
          <SignalBadges s={signal} />
        </div>
      )}


      {relatedNews.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground">
            <Newspaper className="h-3 w-3" /> Related headlines
          </div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {relatedNews.map((n, i) => (
              <li key={i}>
                • {n.headline}
                {n.source ? <span className="opacity-60"> — {n.source}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {guardrails && (
        <div className="mt-2 rounded border border-border/60 bg-background/40 p-2 text-xs text-muted-foreground">
          <div className="mb-1 font-medium text-foreground/80">Guardrail check</div>
          {approved && side === "buy" && (
            <ul className="space-y-0.5">
              <li>
                ✓ Cash floor respected — kept ≥ {currency} {fmtNum(guardrails.cash_floor_value)}
                {" "}({(guardrails.cash_floor_pct * 100).toFixed(0)}% of portfolio)
              </li>
              <li>
                ✓ Position ≤ {currency} {fmtNum(guardrails.max_position_value)} cap
                {" "}({(guardrails.max_position_pct * 100).toFixed(0)}% max)
              </li>
              <li>✓ Within {guardrails.max_new_positions_per_day} new-position daily cap</li>
              <li>✓ No leverage, no borrow, cash-funded</li>
            </ul>
          )}
          {approved && side === "sell" && (
            <ul className="space-y-0.5">
              <li>✓ Held quantity available to sell</li>
              <li>✓ Proceeds returned to cash (no shorting)</li>
            </ul>
          )}
          {!approved && (
            <p>
              ✗ Rejected by guardrail: <span className="text-destructive">{order.rejected}</span>.
              The AI's intent was recorded but no trade was placed.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function DecisionCard({
  decision,
  currency,
}: {
  decision: {
    id: string;
    run_date: string;
    briefing: string | null;
    rationale: string | null;
    portfolio_value: number | string | null;
    raw: unknown;
  };
  currency: string;
}) {
  const raw = (decision.raw ?? {}) as DecisionRaw;
  const executed = raw.executed ?? [];
  const signals = raw.signals ?? [];
  const news = raw.news ?? [];
  const guardrails = raw.guardrails;
  const aiOrders = raw.orders ?? [];
  const signalBySymbol = new Map(signals.map((s) => [s.symbol, s]));
  const weightsByKey = new Map<string, SignalWeights>();
  for (const o of aiOrders) {
    if (!o?.symbol || !o?.side) continue;
    const w = normalizeWeights(o.signal_weights);
    if (w) weightsByKey.set(`${o.symbol.toUpperCase()}:${o.side}`, w);
  }
  const approvedCount = executed.filter((e) => !e.rejected && e.quantity > 0).length;
  const rejectedCount = executed.filter((e) => e.rejected).length;


  return (
    <Card>
      <CardContent className="space-y-4 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="text-sm font-medium">{decision.run_date}</div>
            <div className="text-xs text-muted-foreground">
              {approvedCount} executed · {rejectedCount} blocked by guardrails
            </div>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            Value: {currency} {Number(decision.portfolio_value ?? 0).toFixed(2)}
          </span>
        </div>

        {guardrails && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            <Badge variant="secondary">{guardrails.risk_level}</Badge>
            <Badge variant="outline">
              Max position {(guardrails.max_position_pct * 100).toFixed(0)}%
            </Badge>
            <Badge variant="outline">
              Cash floor {(guardrails.cash_floor_pct * 100).toFixed(0)}%
            </Badge>
            <Badge variant="outline">
              ≤ {guardrails.max_new_positions_per_day} new/day
            </Badge>
            <Badge variant="outline">No leverage</Badge>
          </div>
        )}

        {decision.briefing && (
          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              Market briefing
            </div>
            <p className="text-sm text-muted-foreground">{decision.briefing}</p>
          </div>
        )}
        {decision.rationale && (
          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              Rationale
            </div>
            <p className="text-sm">{decision.rationale}</p>
          </div>
        )}

        {executed.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Order-by-order breakdown
            </div>
            {executed.map((o, i) => (
              <OrderPanel
                key={i}
                order={o}
                signal={signalBySymbol.get(o.symbol.toUpperCase())}
                news={news}
                guardrails={guardrails}
                currency={currency}
                weights={weightsByKey.get(`${o.symbol.toUpperCase()}:${o.side}`)}
              />
            ))}

          </div>
        )}
        {executed.length === 0 && (
          <p className="text-sm text-muted-foreground">
            AI chose to hold — no orders were proposed this tick.
          </p>
        )}

        {(signals.length > 0 || news.length > 0) && (
          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronDown className="h-3 w-3" />
              Show all inputs the AI saw ({signals.length} candidates · {news.length} headlines)
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-3">
              {signals.length > 0 && (
                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                    Candidate signals
                  </div>
                  <div className="space-y-1.5">
                    {signals.map((s) => (
                      <div key={s.symbol} className="flex flex-wrap items-center gap-2">
                        <span className="w-16 shrink-0 text-xs font-medium">{s.symbol}</span>
                        <SignalBadges s={s} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {news.length > 0 && (
                <div>
                  <div className="mb-1 flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground">
                    <Newspaper className="h-3 w-3" /> Headlines fed to the AI
                  </div>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {news.map((n, i) => (
                      <li key={i}>
                        • {n.headline}
                        {n.source ? <span className="opacity-60"> — {n.source}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}

