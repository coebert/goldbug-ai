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
  getDivergenceNarratives,
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
import { ConfirmDialog } from "@/components/confirm-dialog";
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
import { GitCompareArrows, PlayCircle, RefreshCw, Sparkles, Loader2, SlidersHorizontal } from "lucide-react";
import { Explain } from "@/components/explain";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";

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

  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [confirmRerun, setConfirmRerun] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const toggleHidden = (name: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const isolate = (name: string) =>
    setHidden((prev) => {
      // If already isolated to this one, restore all
      if (prev.size > 0 && !prev.has(name) && prev.size === (results?.length ?? 0) - 1) {
        return new Set();
      }
      const next = new Set<string>();
      (results ?? []).forEach((r) => {
        if (r.portfolio.name !== name) next.add(r.portfolio.name);
      });
      return next;
    });

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
                  onClick={() => setConfirmRerun(true)}
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
          <ConfirmDialog
            open={confirmRerun}
            onOpenChange={setConfirmRerun}
            title="Reset and re-run backtests?"
            description={
              <p>
                This will <span className="font-semibold text-destructive">reset</span> the
                selected {selected.length} portfolio(s) and re-run the AI over the last{" "}
                <span className="font-semibold">{days}</span> days. Existing trades and history
                for those portfolios will be replaced.
              </p>
            }
            confirmLabel="Reset and re-run"
            onConfirm={() => {
              setConfirmRerun(false);
              runMut.mutate();
            }}
          />

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center justify-between gap-2">
                  <span>Equity curves (% return)</span>
                  {hidden.size > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => setHidden(new Set())}>
                      Show all
                    </Button>
                  )}
                </CardTitle>
                <CardDescription>
                  Normalised to starting pot. Tap a legend chip to hide/show that line. Double-tap to isolate.
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
                        <XAxis
                          dataKey="date"
                          stroke="hsl(var(--muted-foreground))"
                          fontSize={11}
                          label={{ value: "Date", position: "insideBottom", offset: -2, fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                        />
                        <YAxis
                          stroke="hsl(var(--muted-foreground))"
                          fontSize={11}
                          width={70}
                          tickFormatter={(v) => `${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(1)}%`}
                          label={{ value: "Cumulative return vs start (%)", angle: -90, position: "insideLeft", offset: 8, style: { textAnchor: "middle" }, fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
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
                        {results
                          .filter((r) => !hidden.has(r.portfolio.name))
                          .map((r) => {
                            const i = results.findIndex((x) => x.portfolio.id === r.portfolio.id);
                            return (
                              <Line
                                key={r.portfolio.id}
                                type="monotone"
                                dataKey={r.portfolio.name}
                                stroke={COLORS[i % COLORS.length]}
                                strokeWidth={2}
                                dot={false}
                                activeDot={{ r: 4 }}
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
                          <XAxis
                            dataKey="date"
                            stroke="hsl(var(--muted-foreground))"
                            fontSize={11}
                            label={{ value: "Date", position: "insideBottom", offset: -2, fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                          />
                          <YAxis
                            stroke="hsl(var(--muted-foreground))"
                            fontSize={11}
                            width={70}
                            tickFormatter={(v) => `${Number(v).toFixed(1)}%`}
                            label={{ value: "Drawdown (%)", angle: -90, position: "insideLeft", offset: 8, style: { textAnchor: "middle" }, fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
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
                          {results
                            .filter((r) => !hidden.has(r.portfolio.name))
                            .map((r) => {
                              const i = results.findIndex((x) => x.portfolio.id === r.portfolio.id);
                              return (
                                <Line
                                  key={r.portfolio.id}
                                  type="monotone"
                                  dataKey={r.portfolio.name}
                                  stroke={COLORS[i % COLORS.length]}
                                  strokeWidth={1.5}
                                  strokeOpacity={0.9}
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
                        <th className="py-2 pr-3 text-right"><Explain term="pnl">Return</Explain></th>
                        <th className="py-2 pr-3 text-right"><Explain term="max_drawdown">Max DD</Explain></th>
                        <th className="py-2 pr-3 text-right"><Explain term="sharpe">Sharpe</Explain></th>
                        <th className="py-2 pr-3 text-right"><Explain term="volatility">Vol</Explain></th>
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

            {results && results.length > 0 && (
              <>
                <TradeDivergenceCard
                  portfolioIds={results.map((r) => r.portfolio.id)}
                  names={results.map((r) => r.portfolio.name)}
                  colors={results.map((_, i) => COLORS[i % COLORS.length])}
                />
                {results.length >= 2 && (
                  <DivergenceNarrativesCard
                    portfolioIds={results.map((r) => r.portfolio.id)}
                    names={results.map((r) => r.portfolio.name)}
                    colors={results.map((_, i) => COLORS[i % COLORS.length])}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

type DivergenceRow = Awaited<ReturnType<typeof getTradeComparison>>["results"][number]["rows"][number];

function TradeDivergenceCard({
  portfolioIds,
  names,
  colors,
}: {
  portfolioIds: string[];
  names: string[];
  colors: string[];
}) {
  const fetchCmp = useServerFn(getTradeComparison);
  const [onlyDiverged, setOnlyDiverged] = useState(true);

  const q = useQuery({
    queryKey: ["trade-comparison", portfolioIds.join(",")],
    queryFn: () => fetchCmp({ data: { portfolio_ids: portfolioIds } }),
  });

  const grid = useMemo(() => {
    const results = q.data?.results ?? [];
    // key = date|symbol -> per-portfolio cell
    const map = new Map<string, { date: string; symbol: string; cells: (DivergenceRow | null)[] }>();
    results.forEach((r, idx) => {
      for (const row of r.rows) {
        const key = `${row.date}|${row.symbol}`;
        let entry = map.get(key);
        if (!entry) {
          entry = { date: row.date, symbol: row.symbol, cells: results.map(() => null) };
          map.set(key, entry);
        }
        entry.cells[idx] = row;
      }
    });
    const all = Array.from(map.values()).sort(
      (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.symbol.localeCompare(b.symbol)),
    );
    const isDiverged = (cells: (DivergenceRow | null)[]) => {
      const sigs = cells.map((c) => {
        if (!c) return "none";
        if (c.rejected) return "blocked";
        return c.side === "buy" ? "buy" : "sell";
      });
      return new Set(sigs).size > 1;
    };
    const filtered = onlyDiverged ? all.filter((r) => isDiverged(r.cells)) : all;
    return { rows: filtered, total: all.length, divergedCount: all.filter((r) => isDiverged(r.cells)).length };
  }, [q.data, onlyDiverged]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Trade-by-trade divergence</CardTitle>
        <CardDescription>
          Where portfolios acted differently on the same symbol/day — buys, sells, guardrail blocks, or no-ops.
          Hover any cell to see reason, signals and importance weights.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
          <div>
            {q.isLoading
              ? "Loading trades…"
              : `${grid.divergedCount} diverged / ${grid.total} total (symbol × day) events`}
          </div>
          <label className="flex cursor-pointer items-center gap-2">
            <Checkbox
              checked={onlyDiverged}
              onCheckedChange={(v) => setOnlyDiverged(Boolean(v))}
            />
            Show only diverged rows
          </label>
        </div>
        {!q.isLoading && grid.rows.length === 0 && (
          <div className="rounded-md border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
            {q.data ? "No matching trade events." : "No decisions yet."}
          </div>
        )}
        {grid.rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left uppercase text-muted-foreground">
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">Symbol</th>
                  {names.map((n, i) => (
                    <th key={n} className="py-2 pr-3">
                      <span
                        className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
                        style={{ background: colors[i] }}
                      />
                      {n}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.rows.map((r) => (
                  <tr key={`${r.date}|${r.symbol}`} className="border-b border-border/50 align-top">
                    <td className="py-2 pr-3 tabular-nums text-muted-foreground">{r.date}</td>
                    <td className="py-2 pr-3 font-medium">{r.symbol}</td>
                    {r.cells.map((cell, i) => (
                      <td key={i} className="py-2 pr-3">
                        <TradeCell cell={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TradeCell({ cell }: { cell: DivergenceRow | null }) {
  if (!cell) {
    return <span className="text-muted-foreground/60">—</span>;
  }
  const blocked = !!cell.rejected;
  const isBuy = cell.side === "buy";
  const tone = blocked
    ? "bg-amber-500/15 text-amber-400 border-amber-500/40"
    : isBuy
      ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/40"
      : "bg-rose-500/15 text-rose-400 border-rose-500/40";
  const label = blocked ? "BLOCKED" : isBuy ? "BUY" : "SELL";
  const topWeights = cell.signal_weights
    ? Object.entries(cell.signal_weights)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, 3)
    : [];
  const fmt = (n: number | null | undefined, digits = 2) =>
    n == null || Number.isNaN(n) ? "—" : Number(n).toFixed(digits);
  return (
    <div className="group relative inline-block">
      <div className={`inline-flex flex-col rounded-md border px-2 py-1 ${tone}`}>
        <span className="text-[10px] font-semibold leading-tight">{label}</span>
        {!blocked && cell.executed_value > 0 && (
          <span className="text-[10px] font-normal opacity-80 tabular-nums">
            {cell.executed_value.toFixed(0)} @ {cell.price.toFixed(2)}
          </span>
        )}
        {blocked && (
          <span className="text-[10px] font-normal opacity-80">
            {cell.rejected!.slice(0, 22)}
          </span>
        )}
      </div>
      <div className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-72 rounded-md border border-border bg-card p-2 text-[11px] shadow-xl group-hover:block">
        <div className="mb-1 font-medium">
          {label} {cell.symbol}
          {cell.intent_pct != null && (
            <span className="ml-1 text-muted-foreground">
              (intent {cell.intent_pct.toFixed(0)}%)
            </span>
          )}
        </div>
        {cell.reason && (
          <div className="mb-1 text-muted-foreground">{cell.reason}</div>
        )}
        {blocked && (
          <div className="mb-1 text-amber-400">Guardrail: {cell.rejected}</div>
        )}
        {cell.signals && (
          <div className="mb-1 grid grid-cols-3 gap-x-2 gap-y-0.5 tabular-nums text-muted-foreground">
            <div>RSI {fmt(cell.signals.rsi14, 1)}</div>
            <div>SMA20 {fmt(cell.signals.sma20)}</div>
            <div>SMA50 {fmt(cell.signals.sma50)}</div>
            <div>5d {fmt((cell.signals.change5d ?? 0) * 100, 1)}%</div>
            <div>30d {fmt((cell.signals.change30d ?? 0) * 100, 1)}%</div>
            <div>Vol {fmt((cell.signals.vol20d ?? 0) * 100, 2)}%</div>
          </div>
        )}
        {topWeights.length > 0 && (
          <div className="mt-1 border-t border-border/60 pt-1">
            <div className="mb-0.5 text-[10px] uppercase text-muted-foreground">
              Signal weights
            </div>
            {topWeights.map(([k, v]) => (
              <div key={k} className="flex items-center gap-1">
                <span className="w-24 capitalize">{k.replace(/_/g, " ")}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${Math.min(100, Number(v))}%` }}
                  />
                </div>
                <span className="w-8 text-right tabular-nums">{Number(v).toFixed(0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type NarrativeEvent = Awaited<ReturnType<typeof getDivergenceNarratives>>["events"][number];

function DivergenceNarrativesCard({
  portfolioIds,
  names,
  colors,
}: {
  portfolioIds: string[];
  names: string[];
  colors: string[];
}) {
  const fetchNarr = useServerFn(getDivergenceNarratives);
  const [events, setEvents] = useState<NarrativeEvent[] | null>(null);

  const mut = useMutation({
    mutationFn: () => fetchNarr({ data: { portfolio_ids: portfolioIds, limit: 5 } }),
    onSuccess: (r) => {
      setEvents(r.events);
      if (r.events.length === 0) toast.info("No divergent events found across these portfolios.");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to generate narratives"),
  });

  const actionTone = (a: string) =>
    a === "buy"
      ? "text-emerald-400 border-emerald-500/40 bg-emerald-500/10"
      : a === "sell"
        ? "text-rose-400 border-rose-500/40 bg-rose-500/10"
        : a === "blocked"
          ? "text-amber-400 border-amber-500/40 bg-amber-500/10"
          : "text-muted-foreground border-border bg-muted/30";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          Top 5 divergence narratives
        </CardTitle>
        <CardDescription>
          Plain-English explanations of the biggest disagreements between the selected portfolios — what changed,
          which priors and signals drove each side's decision, and which guardrails stepped in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            Uses Aegis AI to summarise the highest-impact (date × symbol) events where portfolios acted differently.
          </div>
          <Button size="sm" onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Generating…
              </>
            ) : (
              <>
                <Sparkles className="mr-1 h-3.5 w-3.5" /> {events ? "Regenerate" : "Generate narratives"}
              </>
            )}
          </Button>
        </div>
        {!events && !mut.isPending && (
          <div className="rounded-md border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
            Click Generate to have Aegis explain the top divergences.
          </div>
        )}
        {events && events.length === 0 && (
          <div className="rounded-md border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
            No divergent trades found in this window — these portfolios agreed on every action.
          </div>
        )}
        {events && events.length > 0 && (
          <ol className="space-y-3">
            {events.map((ev) => (
              <li key={`${ev.date}|${ev.symbol}`} className="rounded-md border border-border bg-card/50 p-3">
                <div className="mb-2 flex flex-wrap items-baseline gap-2">
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">
                    #{ev.rank}
                  </span>
                  <span className="font-medium">{ev.symbol}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{ev.date}</span>
                </div>
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {ev.portfolios.map((p, i) => (
                    <span
                      key={`${p.name}-${i}`}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${actionTone(p.action)}`}
                    >
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ background: colors[names.indexOf(p.name)] ?? "#888" }}
                      />
                      <span className="font-medium">{p.name}</span>
                      <span className="uppercase opacity-80">{p.action}</span>
                      {p.executed_value > 0 && (
                        <span className="tabular-nums opacity-70">
                          · {p.executed_value.toFixed(0)}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
                <p className="text-sm leading-relaxed text-foreground/90 whitespace-pre-line">
                  {ev.narrative}
                </p>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
