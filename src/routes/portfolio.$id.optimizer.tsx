import { createFileRoute, Link } from "@tanstack/react-router";
import { PortfolioTabs } from "@/components/portfolio-detail/portfolio-tabs";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { runPortfolioOptimizer } from "@/lib/trading.functions";
import { AppHeader } from "@/components/app-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, Sparkles } from "lucide-react";

export const Route = createFileRoute("/portfolio/$id/optimizer")({
  head: () => ({
    meta: [
      { title: "Portfolio Optimizer — Aegis" },
      { name: "description", content: "Compute equal-weight, risk-parity, and max-Sharpe target allocations with rebalance suggestions." },
      { property: "og:title", content: "Portfolio Optimizer — Aegis" },
      { property: "og:description", content: "Target weights and rebalance deltas across your holdings and candidate symbols." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OptimizerPage,
  errorComponent: ({ error, reset }) => (
    <div className="p-6 text-sm">
      <p className="text-destructive">{(error as Error).message}</p>
      <Button className="mt-3" onClick={reset}>Retry</Button>
    </div>
  ),
  notFoundComponent: () => <div className="p-6">Not found</div>,
});

function fmtPct(v: number | null | undefined, d = 2) {
  if (v == null || Number.isNaN(v)) return "—";
  const s = v > 0 ? "+" : "";
  return `${s}${v.toFixed(d)}%`;
}
function fmtMoney(v: number | null | undefined, currency: string) {
  if (v == null || Number.isNaN(v)) return "—";
  const s = v < 0 ? "-" : "";
  return `${s}${currency}${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
function tone(v: number | null | undefined) {
  if (v == null) return "";
  if (v > 0.01) return "text-emerald-500";
  if (v < -0.01) return "text-rose-500";
  return "text-muted-foreground";
}

function OptimizerPage() {
  const { id } = Route.useParams();
  const run = useServerFn(runPortfolioOptimizer);

  const [extras, setExtras] = useState<string>("");
  const [lookback, setLookback] = useState<number>(126);
  const [maxWeight, setMaxWeight] = useState<number>(35);

  const { data, isFetching, refetch, isError, error } = useQuery({
    queryKey: ["optimizer", id],
    queryFn: () =>
      run({
        data: {
          portfolio_id: id,
          extra_symbols: extras
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 20),
          lookback_days: lookback,
          max_weight_pct: maxWeight,
        },
      }),
    refetchOnWindowFocus: false,
  });

  const currency = data?.portfolio.currency ?? "";

  return (
    <div className="min-h-dvh bg-background">
      <AppHeader />
      <div className="mx-auto max-w-7xl px-4"><PortfolioTabs id={id} /></div>
      <div className="mx-auto max-w-6xl 2xl:max-w-7xl px-4 py-5 sm:py-8">
        <div className="mb-4 flex items-center gap-3 flex-wrap">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/portfolio/$id/" params={{ id }}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Back
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" /> Portfolio Optimizer
          </h1>
          {data?.portfolio && <Badge variant="outline">{data.portfolio.name}</Badge>}
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Configuration</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="lg:col-span-2">
              <Label htmlFor="extras">Extra candidate symbols (comma-separated)</Label>
              <Input
                id="extras"
                placeholder="e.g. AAPL, MSFT, VOO, BTC-USD"
                value={extras}
                onChange={(e) => setExtras(e.target.value)}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Adds to your current holdings for the optimisation universe.
              </p>
            </div>
            <div>
              <Label>Lookback: {lookback} trading days</Label>
              <Slider
                min={30}
                max={504}
                step={7}
                value={[lookback]}
                onValueChange={(v) => setLookback(v[0])}
              />
            </div>
            <div>
              <Label>Max weight per name: {maxWeight}%</Label>
              <Slider
                min={5}
                max={100}
                step={1}
                value={[maxWeight]}
                onValueChange={(v) => setMaxWeight(v[0])}
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-4">
              <Button onClick={() => refetch()} disabled={isFetching}>
                {isFetching ? "Optimising…" : "Run optimiser"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {isError && <p className="text-sm text-destructive">{(error as Error).message}</p>}

        {data?.empty && (
          <Card><CardContent className="pt-6 text-sm text-muted-foreground">
            {data.message ?? "Not enough data."}
          </CardContent></Card>
        )}

        {data && !data.empty && (
          <>
            <div className="grid gap-3 sm:grid-cols-3 mb-6">
              <StatTile label="Total value" value={fmtMoney(data.total_value, currency)} />
              <StatTile label="Cash" value={fmtMoney(data.cash, currency)} />
              <StatTile label="Universe" value={`${data.universe.length} symbols`} sub={`Lookback ${data.lookback_days}d · cap ${data.max_weight_pct}%`} />
            </div>

            <Card className="mb-6">
              <CardHeader>
                <CardTitle className="text-base">Per-symbol statistics (annualised)</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase text-muted-foreground border-b">
                      <th className="py-2 pr-3">Symbol</th>
                      <th className="py-2 pr-3 text-right">Last close</th>
                      <th className="py-2 pr-3 text-right">Mean return</th>
                      <th className="py-2 pr-3 text-right">Volatility</th>
                      <th className="py-2 pr-3 text-right">Sharpe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.stats.map((s) => (
                      <tr key={s.symbol} className="border-b last:border-b-0">
                        <td className="py-2 pr-3 font-medium">{s.symbol}</td>
                        <td className="py-2 pr-3 text-right font-mono">{s.last_close ? s.last_close.toFixed(2) : "—"}</td>
                        <td className={`py-2 pr-3 text-right font-mono ${tone(s.mean_ann_pct)}`}>{fmtPct(s.mean_ann_pct)}</td>
                        <td className="py-2 pr-3 text-right font-mono">{fmtPct(s.vol_ann_pct)}</td>
                        <td className={`py-2 pr-3 text-right font-mono ${tone(s.sharpe)}`}>{s.sharpe.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <Tabs defaultValue="risk_parity">
              <TabsList>
                <TabsTrigger value="risk_parity">Risk parity (inv-vol)</TabsTrigger>
                <TabsTrigger value="max_sharpe">Max Sharpe (mean-variance)</TabsTrigger>
                <TabsTrigger value="equal">Equal weight</TabsTrigger>
              </TabsList>

              <TabsContent value="risk_parity">
                <WeightsTable
                  currency={currency}
                  current={data.current}
                  target={data.weights.risk_parity}
                  rebalance={data.rebalance.risk_parity}
                  caption="Weights inversely proportional to each asset's volatility, then capped and normalised."
                />
              </TabsContent>
              <TabsContent value="max_sharpe">
                <WeightsTable
                  currency={currency}
                  current={data.current}
                  target={data.weights.max_sharpe}
                  rebalance={data.rebalance.max_sharpe}
                  caption="Unconstrained tangency portfolio (C⁻¹ μ), long-only, capped and normalised."
                />
              </TabsContent>
              <TabsContent value="equal">
                <WeightsTable
                  currency={currency}
                  current={data.current}
                  target={data.weights.equal}
                  rebalance={data.current.map((c) => {
                    const eqW = 100 / data.universe.length;
                    const targetValue = (eqW / 100) * data.total_value;
                    return {
                      symbol: c.symbol,
                      delta_pct: Number((eqW - c.weight_pct).toFixed(2)),
                      delta_value: Number((targetValue - c.value).toFixed(2)),
                    };
                  })}
                  caption="Naïve 1/N benchmark."
                />
              </TabsContent>
            </Tabs>

            <p className="text-xs text-muted-foreground mt-4">
              Target weights are suggestions only — rebalance actions still route through the AI decision engine and guardrails before any trade fires.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold mt-1">{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function WeightsTable({
  currency,
  current,
  target,
  rebalance,
  caption,
}: {
  currency: string;
  current: Array<{ symbol: string; weight_pct: number; value: number }>;
  target: Array<{ symbol: string; weight_pct: number }>;
  rebalance: Array<{ symbol: string; delta_pct: number; delta_value: number }>;
  caption: string;
}) {
  const byS = new Map(current.map((c) => [c.symbol, c]));
  const rbS = new Map(rebalance.map((r) => [r.symbol, r]));
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="text-xs text-muted-foreground mb-3">{caption}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-muted-foreground border-b">
                <th className="py-2 pr-3">Symbol</th>
                <th className="py-2 pr-3 text-right">Current</th>
                <th className="py-2 pr-3 text-right">Target</th>
                <th className="py-2 pr-3 text-right">Δ weight</th>
                <th className="py-2 pr-3 text-right">Δ value ({currency})</th>
                <th className="py-2 pr-3">Bar</th>
              </tr>
            </thead>
            <tbody>
              {target.map((t) => {
                const cur = byS.get(t.symbol);
                const rb = rbS.get(t.symbol);
                return (
                  <tr key={t.symbol} className="border-b last:border-b-0">
                    <td className="py-2 pr-3 font-medium">{t.symbol}</td>
                    <td className="py-2 pr-3 text-right font-mono">{(cur?.weight_pct ?? 0).toFixed(2)}%</td>
                    <td className="py-2 pr-3 text-right font-mono">{t.weight_pct.toFixed(2)}%</td>
                    <td className={`py-2 pr-3 text-right font-mono ${tone(rb?.delta_pct)}`}>{fmtPct(rb?.delta_pct)}</td>
                    <td className={`py-2 pr-3 text-right font-mono ${tone(rb?.delta_value)}`}>{fmtMoney(rb?.delta_value ?? 0, currency)}</td>
                    <td className="py-2 pr-3 w-40">
                      <div className="flex items-center gap-1 h-2">
                        <div className="h-2 bg-muted rounded" style={{ width: `${Math.min(100, cur?.weight_pct ?? 0)}%` }} title={`current ${cur?.weight_pct ?? 0}%`} />
                        <div className="h-2 bg-primary rounded" style={{ width: `${Math.min(100, t.weight_pct)}%` }} title={`target ${t.weight_pct}%`} />
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
  );
}
