import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getPortfolio } from "@/lib/trading.functions";
import { runWalkForward } from "@/lib/walk-forward.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { AppHeader } from "@/components/app-header";
import { PageLoading } from "@/components/page-loading";
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
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { PlayCircle, SplitSquareHorizontal } from "lucide-react";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART_ROLE,
  GRID_PROPS,
  REFERENCE_LINE,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_ITEM_STYLE,
  TOOLTIP_LABEL_STYLE,
} from "@/lib/chart-palette";
import { qk } from "@/lib/query-keys";

export const Route = createFileRoute("/walk-forward/$id")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Walk-forward evaluation — Aegis" },
      {
        name: "description",
        content:
          "Score the strategy out of sample with rolling train/test folds before enabling the live autopilot: OOS Sharpe, drawdown, fold hit rate and over-fitting checks.",
      },
      { property: "og:title", content: "Walk-forward evaluation — Aegis" },
      {
        property: "og:description",
        content:
          "Rolling train/test folds that measure how the trading strategy holds up on untouched historical periods.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: WalkForwardPage,
});

type WFResult = Awaited<ReturnType<typeof runWalkForward>>;

function fmtPct(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

const VERDICT_STYLES: Record<string, string> = {
  go: "bg-primary/15 text-primary border-primary/30",
  caution: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  "no-go": "bg-destructive/15 text-destructive border-destructive/30",
};

const VERDICT_LABEL: Record<string, string> = {
  go: "Ready for autopilot",
  caution: "Proceed with caution",
  "no-go": "Not ready",
};

function WalkForwardPage() {
  const navigate = useNavigate();
  const { id } = useParams({ from: "/walk-forward/$id" });
  const [session, setSession] =
    useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]>(null);
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
  const runWF = useServerFn(runWalkForward);

  const pQ = useQuery({
    queryKey: qk.portfolio.detail(id),
    queryFn: () => getP({ data: { id } }),
    enabled: !!session,
  });

  const [from, setFrom] = useState("2010-01-01");
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [trainDays, setTrainDays] = useState(504);
  const [testDays, setTestDays] = useState(126);
  const [mode, setMode] = useState<"rolling" | "anchored">("rolling");
  const [objective, setObjective] = useState<"sharpe" | "return" | "calmar">("sharpe");
  const [maxFolds, setMaxFolds] = useState(8);
  const [result, setResult] = useState<WFResult | null>(null);

  const runMut = useMutation({
    mutationFn: () =>
      runWF({
        data: {
          portfolio_id: id,
          from,
          to,
          train_days: trainDays,
          test_days: testDays,
          mode,
          objective,
          max_folds: maxFolds,
        },
      }),
    onSuccess: (r) => {
      setResult(r);
      if (r.folds.length === 0) {
        toast.error("No folds completed — widen the date range or shorten the windows.");
      } else {
        toast.success(`${r.folds.length} out-of-sample folds evaluated`);
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Walk-forward run failed"),
  });

  const chartData = useMemo(() => {
    if (!result || result.oos_curve.length === 0) return [];
    const base = result.starting_cash;
    return result.oos_curve.map((p) => ({
      date: p.date,
      pct: ((p.value - base) / base) * 100,
    }));
  }, [result]);

  if (!ready || !session) return <PageLoading />;

  const portfolio = pQ.data?.portfolio;
  const s = result?.summary;

  return (
    <div className="min-h-dvh">
      <AppHeader email={session.user.email} />
      <main className="mx-auto max-w-6xl px-4 py-5 sm:py-8">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <SplitSquareHorizontal className="h-6 w-6 text-primary" /> Walk-forward evaluation
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
          <div className="flex gap-2">
            <Link to="/long-horizon/$id" params={{ id }}>
              <Button variant="outline" size="sm">
                Long-horizon backtest
              </Button>
            </Link>
            <Link to="/portfolio/$id" params={{ id }}>
              <Button variant="outline" size="sm">
                Back to portfolio
              </Button>
            </Link>
          </div>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Fold setup — train once, score on untouched data</CardTitle>
            <CardDescription>
              Parameters are chosen on each training window only, then scored on the following
              out-of-sample window. Consistent OOS results are the pre-flight check for the live
              autopilot.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <Label htmlFor="wf-from">From</Label>
              <Input id="wf-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="wf-to">To</Label>
              <Input id="wf-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="wf-train">Train days</Label>
              <Input
                id="wf-train"
                type="number"
                value={trainDays}
                min={90}
                max={2000}
                onChange={(e) => setTrainDays(Number(e.target.value))}
              />
            </div>
            <div>
              <Label htmlFor="wf-test">Test days</Label>
              <Input
                id="wf-test"
                type="number"
                value={testDays}
                min={30}
                max={750}
                onChange={(e) => setTestDays(Number(e.target.value))}
              />
            </div>
            <div>
              <Label>Window</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rolling">Rolling (fixed length)</SelectItem>
                  <SelectItem value="anchored">Anchored (growing)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Selection objective</Label>
              <Select value={objective} onValueChange={(v) => setObjective(v as typeof objective)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sharpe">Sharpe</SelectItem>
                  <SelectItem value="calmar">Calmar (return / drawdown)</SelectItem>
                  <SelectItem value="return">Total return</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="wf-folds">Max folds</Label>
              <Input
                id="wf-folds"
                type="number"
                value={maxFolds}
                min={1}
                max={12}
                onChange={(e) => setMaxFolds(Number(e.target.value))}
              />
            </div>
            <div className="flex items-end">
              <Button
                className="w-full"
                onClick={() => runMut.mutate()}
                disabled={runMut.isPending}
              >
                <PlayCircle className="mr-2 h-4 w-4" />
                {runMut.isPending ? "Evaluating…" : "Run walk-forward"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {s && (
          <Card className="mb-6">
            <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
              <div>
                <CardTitle className="text-base">Out-of-sample verdict</CardTitle>
                <CardDescription>
                  {s.folds} fold(s) · train {result?.train_days}d / test {result?.test_days}d ·{" "}
                  {result?.mode}
                </CardDescription>
              </div>
              <Badge variant="outline" className={VERDICT_STYLES[s.verdict]}>
                {VERDICT_LABEL[s.verdict]}
              </Badge>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: "OOS return", value: fmtPct(s.oosTotalReturnPct) },
                  { label: "OOS CAGR", value: fmtPct(s.oosCagrPct) },
                  { label: "OOS Sharpe", value: s.oosSharpe.toFixed(2) },
                  { label: "Worst drawdown", value: fmtPct(s.oosMaxDrawdownPct) },
                  { label: "Profitable folds", value: `${Math.round(s.foldHitRate * 100)}%` },
                  { label: "Sharpe decay (IS→OOS)", value: s.degradation.toFixed(2) },
                  { label: "Param stability", value: `${Math.round(s.paramStability * 100)}%` },
                  {
                    label: "Vs SPY",
                    value: s.excessReturnPct == null ? "n/a" : fmtPct(s.excessReturnPct),
                  },
                ].map((m) => (
                  <div key={m.label} className="rounded-lg border bg-card/50 p-3">
                    <div className="text-xs text-muted-foreground">{m.label}</div>
                    <div className="text-lg font-semibold tabular-nums">{m.value}</div>
                  </div>
                ))}
              </div>
              <ul className="mt-4 space-y-1 text-sm text-muted-foreground">
                {s.reasons.map((r) => (
                  <li key={r}>• {r}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {chartData.length > 1 && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base">Stitched out-of-sample equity</CardTitle>
              <CardDescription>
                Test windows chained end to end — the track record the autopilot would have produced
                on data it never trained on.
              </CardDescription>
            </CardHeader>
            <CardContent className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis dataKey="date" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={TICK_LINE} minTickGap={40} />
                  <YAxis
                    tick={AXIS_TICK}
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                    tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                    width={64}
                  />
                  <Tooltip
                    formatter={(v: number) => fmtPct(Number(v))}
                    contentStyle={TOOLTIP_CONTENT_STYLE}
                    labelStyle={TOOLTIP_LABEL_STYLE}
                    itemStyle={TOOLTIP_ITEM_STYLE}
                  />
                  <ReferenceLine y={0} {...REFERENCE_LINE} />
                  <Line
                    type="monotone"
                    dataKey="pct"
                    name="Out-of-sample"
                    stroke={CHART_ROLE.positive}
                    dot={false}
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {result && result.folds.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Fold detail</CardTitle>
              <CardDescription>
                Selected parameters per fold and how the training fit held up on the test window.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-xs uppercase text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-2 text-left">Fold</th>
                    <th className="text-left">Train</th>
                    <th className="text-left">Test</th>
                    <th className="text-left">Params</th>
                    <th className="text-right">IS Sharpe</th>
                    <th className="text-right">OOS Sharpe</th>
                    <th className="text-right">OOS return</th>
                    <th className="text-right">SPY</th>
                  </tr>
                </thead>
                <tbody>
                  {result.folds.map((f) => (
                    <tr key={f.index} className="border-b last:border-0">
                      <td className="py-2">{f.index + 1}</td>
                      <td className="text-xs text-muted-foreground">
                        {f.train.from} → {f.train.to}
                      </td>
                      <td className="text-xs text-muted-foreground">
                        {f.test.from} → {f.test.to}
                      </td>
                      <td className="text-xs">
                        {f.params.rebalance}, top {f.params.top_k}
                      </td>
                      <td className="text-right tabular-nums">{f.inSample.sharpe.toFixed(2)}</td>
                      <td className="text-right tabular-nums">{f.outOfSample.sharpe.toFixed(2)}</td>
                      <td
                        className={`text-right tabular-nums ${f.outOfSample.totalReturnPct >= 0 ? "text-primary" : "text-destructive"}`}
                      >
                        {fmtPct(f.outOfSample.totalReturnPct)}
                      </td>
                      <td className="text-right tabular-nums text-muted-foreground">
                        {f.benchmark ? fmtPct(f.benchmark.totalReturnPct) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
