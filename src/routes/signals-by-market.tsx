import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, RefreshCw } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/layout/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLiveFillStream } from "@/hooks/use-live-fill-stream";
import { getSignalsByMarket } from "@/lib/signals-by-market.functions";
import type { MarketSignalRow } from "@/lib/signals-by-market";

const DESCRIPTION = "Current AI signals, confidence, expected edge and coverage gaps across every configured market.";

export const Route = createFileRoute("/signals-by-market")({
  component: SignalsByMarketPage,
  head: () => ({
    meta: [
      { title: "Signals by market | Goldbug" },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: "Signals by market | Goldbug" },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

const fmtPct = (value: number | null) => value == null ? "—" : `${(value * 100).toFixed(0)}%`;
const fmtEdge = (value: number | null) => value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(0)} bps`;
const fmtPrice = (value: number | null) => value == null ? "—" : new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(value);

function directionIcon(row: MarketSignalRow) {
  if (row.direction === "bullish") return <ArrowUpRight className="h-4 w-4 text-positive" aria-hidden />;
  if (row.direction === "bearish") return <ArrowDownRight className="h-4 w-4 text-destructive" aria-hidden />;
  return <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden />;
}

function SignalsByMarketPage() {
  const load = useServerFn(getSignalsByMarket);
  const [market, setMarket] = useState("all");
  const [coverage, setCoverage] = useState("all");
  const query = useQuery({
    queryKey: ["signals-by-market"],
    queryFn: () => load({ data: {} }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  useLiveFillStream(query.data?.portfolioId ?? null, () => void query.refetch());
  const groups = useMemo(() => (query.data?.groups ?? [])
    .filter((group) => market === "all" || group.market === market)
    .map((group) => ({ ...group, rows: group.rows.filter((row) => coverage === "all" || row.coverage === coverage) }))
    .filter((group) => group.rows.length > 0), [query.data, market, coverage]);
  const data = query.data;

  return <>
    <AppHeader />
    <PageShell title="Signals by market" purpose="See where the AI has evidence, where an opportunity is strongest, and where missing or stale inputs leave a gap." actions={
      <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw className={query.isFetching ? "animate-spin" : ""} /> Refresh</Button>
    }>
      {query.isLoading ? <Card><CardContent className="p-6 text-sm text-muted-foreground">Loading market signals…</CardContent></Card>
      : query.error ? <Card><CardContent className="p-6 text-sm text-destructive">{(query.error as Error).message}</CardContent></Card>
      : !data ? <Card><CardContent className="p-6 text-sm text-muted-foreground">No active portfolio was found.</CardContent></Card>
      : <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label="Markets" value={String(data.groups.length)} />
          <Metric label="Signals covered" value={`${data.covered}/${data.total}`} />
          <Metric label="Coverage gaps" value={String(data.gaps)} attention={data.gaps > 0} />
          <Metric label="Open now" value={String(data.groups.filter((group) => group.marketOpen).length)} />
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-muted-foreground">{data.portfolioName} · latest stored signal {data.decisionAt ? new Date(data.decisionAt).toLocaleString("en-GB") : "not available"}</div>
          <div className="flex gap-2">
            <Select value={market} onValueChange={setMarket}><SelectTrigger className="w-[170px]" aria-label="Filter by market"><SelectValue placeholder="All markets" /></SelectTrigger><SelectContent><SelectItem value="all">All markets</SelectItem>{data.groups.map((group) => <SelectItem key={group.market} value={group.market}>{group.label}</SelectItem>)}</SelectContent></Select>
            <Select value={coverage} onValueChange={setCoverage}><SelectTrigger className="w-[160px]" aria-label="Filter by coverage"><SelectValue placeholder="All coverage" /></SelectTrigger><SelectContent><SelectItem value="all">All coverage</SelectItem><SelectItem value="covered">Covered</SelectItem><SelectItem value="no_signal">No signal</SelectItem><SelectItem value="unmeasured">Unmeasured</SelectItem><SelectItem value="stale_price">Stale price</SelectItem><SelectItem value="blocked">Broker blocked</SelectItem></SelectContent></Select>
          </div>
        </div>
        {groups.map((group) => <section key={group.market} className="space-y-2" aria-labelledby={`market-${group.market}`}>
          <div className="flex flex-wrap items-end justify-between gap-2"><div><div className="flex items-center gap-2"><h2 id={`market-${group.market}`} className="text-base font-semibold">{group.label}</h2><Badge variant={group.marketOpen ? "default" : "secondary"}>{group.marketOpen ? "Open" : "Closed"}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{group.covered}/{group.total} covered · average confidence {fmtPct(group.averageConfidence)} · expected edge {fmtEdge(group.averageExpectedEdgeBps)}</p></div>{group.strongest && <div className="text-xs text-muted-foreground">Strongest: <span className="font-medium text-foreground">{group.strongest.symbol}</span></div>}</div>
          <div className="overflow-hidden rounded-md border border-border bg-card">
            <div className="hidden grid-cols-[minmax(150px,1.2fr)_90px_90px_100px_90px_minmax(180px,1fr)] gap-3 border-b border-border bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground md:grid"><span>Symbol</span><span>Signal</span><span>Confidence</span><span>Expected edge</span><span>Price</span><span>Coverage</span></div>
            {group.rows.map((row) => <div key={row.symbolKey} className="grid gap-3 border-b border-border px-4 py-3 last:border-b-0 md:grid-cols-[minmax(150px,1.2fr)_90px_90px_100px_90px_minmax(180px,1fr)] md:items-center">
              <div className="min-w-0"><Link to="/symbols" search={{ symbol: row.symbol }} className="font-medium text-foreground hover:text-primary">{row.symbol}</Link><div className="truncate text-xs text-muted-foreground">{row.name} · {row.venue}</div></div>
              <div className="flex items-center gap-1.5 text-sm capitalize">{directionIcon(row)} {row.direction}</div>
              <Value label="Confidence" value={fmtPct(row.confidence)} /><Value label="Expected edge" value={fmtEdge(row.expectedEdgeBps)} strong={row.expectedEdgeBps != null && row.expectedEdgeBps > 0} /><Value label="Price" value={fmtPrice(row.price)} />
              <div>{row.gapLabel ? <div className="flex items-start gap-1.5 text-xs text-warning"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{row.gapLabel}</div> : <div className="flex items-center gap-1.5 text-xs text-positive"><Activity className="h-3.5 w-3.5" />Current</div>}<div className="mt-1 text-xs text-muted-foreground">{row.marketOpen ? "Market open" : "Market closed"}{row.priceDate ? ` · price ${row.priceDate}` : ""}</div></div>
            </div>)}
          </div>
        </section>)}
        {groups.length === 0 && <Card><CardContent className="p-6 text-sm text-muted-foreground">No signals match these filters.</CardContent></Card>}
      </div>}
    </PageShell>
  </>;
}

function Metric({ label, value, attention = false }: { label: string; value: string; attention?: boolean }) {
  return <Card><CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle></CardHeader><CardContent><div className={attention ? "text-2xl font-semibold text-warning" : "text-2xl font-semibold"}>{value}</div></CardContent></Card>;
}

function Value({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div className="text-sm"><span className="mr-2 text-xs text-muted-foreground md:hidden">{label}</span><span className={strong ? "font-medium text-positive" : ""}>{value}</span></div>;
}