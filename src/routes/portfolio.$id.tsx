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
import { RiskControlsCard } from "@/components/risk-controls-card";


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

            <div className="mb-6">
              <RiskControlsCard portfolioId={id} riskConfig={p.risk_config} />
            </div>

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

