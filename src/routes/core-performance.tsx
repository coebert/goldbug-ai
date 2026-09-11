import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/layout/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AXIS_LINE, AXIS_TICK, CHART_SEQUENCE, GRID_PROPS, LEGEND_PROPS, TICK_LINE, TOOLTIP_CONTENT_STYLE, TOOLTIP_ITEM_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_WRAPPER_STYLE } from "@/lib/chart-palette";
import { mergeNormalisedSeries } from "@/lib/core-performance";
import { getCorePerformance } from "@/lib/core-performance.functions";
import { formatMoney } from "@/lib/format-money";

const DESCRIPTION = "VWRL price history, returns, drawdown and a real-price comparison of the 50% core target with close global peers.";

export const Route = createFileRoute("/core-performance")({
  component: CorePerformancePage,
  head: () => ({ meta: [
    { title: "VWRL core performance | Aegis" },
    { name: "description", content: DESCRIPTION },
    { property: "og:title", content: "VWRL core performance | Aegis" },
    { property: "og:description", content: DESCRIPTION },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
  ] }),
});

const percent = (value: number | null, digits = 1) => value == null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
const riskPercent = (value: number | null) => value == null ? "—" : `${(Math.abs(value) * 100).toFixed(1)}%`;
const dateLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });

function CorePerformancePage() {
  const load = useServerFn(getCorePerformance);
  const [years, setYears] = useState<1 | 3 | 5>(3);
  const query = useQuery({
    queryKey: ["core-performance", years],
    queryFn: () => load({ data: { years } }),
    staleTime: 5 * 60_000,
  });
  const data = query.data;
  const chartRows = useMemo(() => mergeNormalisedSeries(data?.comparisonFunds ?? []), [data]);
  const core = data?.funds[0];
  const available = data?.comparisonFunds.filter((fund) => fund.metrics) ?? [];
  const comparisonCore = data?.comparisonFunds[0];

  return <><AppHeader /><PageShell
    title="Core performance"
    purpose="Track VWRL’s real return and risk in pounds, then compare the 50% core target with close global funds."
    actions={<div className="flex items-center gap-2"><Button variant="outline" size="sm" asChild><Link to="/core-progress"><ArrowLeft className="h-4 w-4" /> Progress</Link></Button><Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw className={query.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Refresh</Button></div>}
  >
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">All returns include daily currency movement and are shown in pounds.</p>
        <Tabs value={String(years)} onValueChange={(value) => setYears(Number(value) as 1 | 3 | 5)}><TabsList aria-label="Performance period"><TabsTrigger value="1">1 year</TabsTrigger><TabsTrigger value="3">3 years</TabsTrigger><TabsTrigger value="5">5 years</TabsTrigger></TabsList></Tabs>
      </div>
      {query.isLoading ? <Card><CardContent className="p-6 text-sm text-muted-foreground">Loading real price history…</CardContent></Card>
      : query.error ? <Card><CardContent className="p-6 text-sm text-destructive">{(query.error as Error).message}</CardContent></Card>
      : !data || !core ? <Card><CardContent className="p-6 text-sm text-muted-foreground">No live core portfolio was found.</CardContent></Card>
      : <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label={`${core.symbol} return`} value={percent(core.metrics?.totalReturn ?? null)} detail={core.metrics ? `${core.metrics.startDate} to ${core.metrics.endDate}` : "history unavailable"} tone={(core.metrics?.totalReturn ?? 0) >= 0 ? "positive" : "negative"} />
          <Metric label="Annualised return" value={percent(core.metrics?.annualisedReturn ?? null)} detail={`${years}-year annual pace`} />
          <Metric label="Maximum drawdown" value={riskPercent(core.metrics?.maxDrawdown ?? null)} detail="largest peak-to-trough fall" tone="negative" />
          <Metric label="Annual volatility" value={riskPercent(core.metrics?.annualisedVolatility ?? null)} detail="daily moves, annualised" />
        </div>

        <section className="space-y-2" aria-labelledby="core-price-title">
          <div className="flex flex-wrap items-end justify-between gap-2"><div><h2 id="core-price-title" className="text-base font-semibold">VWRL price history</h2><p className="text-xs text-muted-foreground">Adjusted to pounds per unit; latest {formatMoney(core.metrics?.latestPrice ?? null, "GBP")}.</p></div>{core.metrics ? <Badge variant="outline">Range {formatMoney(core.metrics.low, "GBP")}–{formatMoney(core.metrics.high, "GBP")}</Badge> : null}</div>
          <Card><CardContent className="pt-6"><div className="h-72 w-full" role="img" aria-label={`VWRL price history over ${years} years`}><ResponsiveContainer><LineChart data={core.series} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}><CartesianGrid {...GRID_PROPS} /><XAxis dataKey="date" tick={AXIS_TICK} tickFormatter={dateLabel} minTickGap={44} axisLine={AXIS_LINE} tickLine={TICK_LINE} /><YAxis width={62} tick={AXIS_TICK} tickFormatter={(value) => `£${Number(value).toFixed(0)}`} axisLine={AXIS_LINE} tickLine={TICK_LINE} domain={["auto", "auto"]} /><Tooltip contentStyle={TOOLTIP_CONTENT_STYLE} wrapperStyle={TOOLTIP_WRAPPER_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} itemStyle={TOOLTIP_ITEM_STYLE} labelFormatter={(label) => dateLabel(String(label))} formatter={(value) => [formatMoney(Number(value), "GBP"), "VWRL"]} /><Line type="monotone" dataKey="close" name="VWRL" stroke={CHART_SEQUENCE[0]} strokeWidth={2.25} dot={false} /></LineChart></ResponsiveContainer></div></CardContent></Card>
        </section>

        <section className="space-y-2" aria-labelledby="peer-chart-title">
          <div><h2 id="peer-chart-title" className="text-base font-semibold">Global peers</h2><p className="text-xs text-muted-foreground">Growth from the first available day in each fund’s selected window, after conversion to pounds.</p></div>
          <Card><CardContent className="pt-6"><div className="h-80 w-full" role="img" aria-label="Normalised return chart comparing VWRL with global peers"><ResponsiveContainer><LineChart data={chartRows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}><CartesianGrid {...GRID_PROPS} /><XAxis dataKey="date" tick={AXIS_TICK} tickFormatter={dateLabel} minTickGap={44} axisLine={AXIS_LINE} tickLine={TICK_LINE} /><YAxis width={58} tick={AXIS_TICK} tickFormatter={(value) => `${Number(value).toFixed(0)}%`} axisLine={AXIS_LINE} tickLine={TICK_LINE} /><Tooltip contentStyle={TOOLTIP_CONTENT_STYLE} wrapperStyle={TOOLTIP_WRAPPER_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} itemStyle={TOOLTIP_ITEM_STYLE} labelFormatter={(label) => dateLabel(String(label))} formatter={(value, name) => [`${Number(value).toFixed(1)}%`, name]} /><Legend {...LEGEND_PROPS} />{available.map((fund, index) => <Line key={fund.symbol} type="monotone" dataKey={fund.symbol} name={fund.symbol} stroke={CHART_SEQUENCE[index % CHART_SEQUENCE.length]} strokeWidth={fund.symbol === core.symbol ? 2.5 : 1.75} strokeDasharray={fund.symbol === core.symbol ? undefined : "6 3"} connectNulls dot={false} />)}</LineChart></ResponsiveContainer></div></CardContent></Card>
        </section>

        <section className="space-y-2" aria-labelledby="comparison-title"><div><h2 id="comparison-title" className="text-base font-semibold">Return and risk comparison</h2><p className="text-xs text-muted-foreground">Compared over the same available dates; unavailable peers stay visible without affecting the ranking.</p></div><div className="overflow-x-auto rounded-md border border-border bg-card"><Table><TableHeader><TableRow><TableHead>Fund</TableHead><TableHead className="text-right">Return</TableHead><TableHead className="text-right">Annualised</TableHead><TableHead className="text-right">Volatility</TableHead><TableHead className="text-right">Max drawdown</TableHead><TableHead className="text-right">vs VWRL</TableHead></TableRow></TableHeader><TableBody>{data.comparisonFunds.map((fund) => <TableRow key={fund.symbol}><TableCell><div className="font-medium">{fund.symbol}</div><div className="max-w-56 text-xs text-muted-foreground">{fund.name}</div></TableCell><TableCell className="text-right tabular-nums">{percent(fund.metrics?.totalReturn ?? null)}</TableCell><TableCell className="text-right tabular-nums">{percent(fund.metrics?.annualisedReturn ?? null)}</TableCell><TableCell className="text-right tabular-nums">{riskPercent(fund.metrics?.annualisedVolatility ?? null)}</TableCell><TableCell className="text-right tabular-nums">{riskPercent(fund.metrics?.maxDrawdown ?? null)}</TableCell><TableCell className="text-right tabular-nums">{fund.metrics && comparisonCore?.metrics ? percent(fund.metrics.totalReturn - comparisonCore.metrics.totalReturn) : "—"}</TableCell></TableRow>)}</TableBody></Table></div></section>

        <section className="space-y-2" aria-labelledby="allocation-title"><div><h2 id="allocation-title" className="text-base font-semibold">What the 50% target changes</h2><p className="text-xs text-muted-foreground">Half the account follows the fund over the common comparison window; the other half is held flat. Trading profits, costs and rebalancing are excluded.</p></div><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{data.comparisonFunds.map((fund) => <Card key={fund.symbol}><CardHeader className="pb-2"><CardTitle className="text-sm">50% in {fund.symbol}</CardTitle></CardHeader><CardContent><div className="text-2xl font-semibold tabular-nums">{percent(fund.targetAllocationReturn)}</div><p className="mt-1 text-xs text-muted-foreground">account impact on matched dates</p></CardContent></Card>)}</div><div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground"><span>Current core: <strong className="text-foreground">{(data.currentPct * 100).toFixed(1)}%</strong></span><span>Target: <strong className="text-foreground">{(data.targetPct * 100).toFixed(0)}%</strong></span><span>Target band: <strong className="text-foreground">±{(data.bandPct * 100).toFixed(0)}%</strong></span><span>Current value: <strong className="text-foreground">{formatMoney(data.coreValueBase, "GBP")}</strong></span></div></section>
      </>}
    </div>
  </PageShell></>;
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: "positive" | "negative" }) {
  const toneClass = tone === "positive" ? "text-positive" : tone === "negative" ? "text-destructive" : "text-foreground";
  return <Card><CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle></CardHeader><CardContent><div className={`text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div><p className="mt-1 text-xs text-muted-foreground">{detail}</p></CardContent></Card>;
}
