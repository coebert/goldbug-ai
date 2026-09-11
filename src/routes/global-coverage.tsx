import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, RefreshCw, Target } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/layout/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLiveFillStream } from "@/hooks/use-live-fill-stream";
import { formatMoneySigned } from "@/lib/format-money";
import { getGlobalCoverage } from "@/lib/global-coverage.functions";

const DESCRIPTION = "Fill rates and missed trading signals across every market group available to the AI.";

export const Route = createFileRoute("/global-coverage")({
  component: GlobalCoveragePage,
  head: () => ({ meta: [
    { title: "Global coverage | Aegis" }, { name: "description", content: DESCRIPTION },
    { property: "og:title", content: "Global coverage | Aegis" }, { property: "og:description", content: DESCRIPTION },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" },
  ] }),
});

const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
const dateLabel = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "Europe/London" });

function GlobalCoveragePage() {
  const load = useServerFn(getGlobalCoverage);
  const [days, setDays] = useState<30 | 60 | 90>(60);
  const [market, setMarket] = useState("all");
  const [reason, setReason] = useState("all");
  const query = useQuery({ queryKey: ["global-coverage", days], queryFn: () => load({ data: { days } }), staleTime: 60_000, refetchInterval: 5 * 60_000 });
  useLiveFillStream(query.data?.portfolioId ?? null, () => void query.refetch());
  const groups = useMemo(() => (query.data?.groups ?? []).filter((group) => market === "all" || group.market === market), [query.data, market]);
  const missed = useMemo(() => groups.flatMap((group) => group.rows).filter((row) => row.status === "missed" && (reason === "all" || row.missReason === reason)).sort((a, b) => (b.missedOutcomeBase ?? 0) - (a.missedOutcomeBase ?? 0)), [groups, reason]);
  const data = query.data;
  return <><AppHeader /><PageShell title="Global coverage" purpose="See which markets turn promising signals into real fills, and which opportunities are falling through the gaps." actions={<Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw className={query.isFetching ? "animate-spin" : ""} /> Refresh</Button>}>
    {query.isLoading ? <Card><CardContent className="p-6 text-sm text-muted-foreground">Loading global coverage…</CardContent></Card>
    : query.error ? <Card><CardContent className="p-6 text-sm text-destructive">{(query.error as Error).message}</CardContent></Card>
    : !data ? <Card><CardContent className="p-6 text-sm text-muted-foreground">No active portfolio was found.</CardContent></Card>
    : <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Metric label="Signals" value={String(data.suggestions)} detail={`${data.days} days`} /><Metric label="Quantity filled" value={pct(data.fillRate)} detail={`${data.filled} signals touched`} /><Metric label="Missed" value={String(data.missed)} detail={`${data.pending} still pending`} attention={data.missed > 0} /><Metric label="Missed result" value={formatMoneySigned(data.missedProfitBase, data.currency)} detail="paper result after charges" attention={data.missedProfitBase > 0} /></div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-sm text-muted-foreground">{data.portfolioName} · fills are matched within three days of each signal</p><div className="flex gap-2"><Select value={String(days)} onValueChange={(value) => setDays(Number(value) as 30 | 60 | 90)}><SelectTrigger className="w-[120px]" aria-label="Coverage period"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="30">30 days</SelectItem><SelectItem value="60">60 days</SelectItem><SelectItem value="90">90 days</SelectItem></SelectContent></Select><Select value={market} onValueChange={setMarket}><SelectTrigger className="w-[165px]" aria-label="Market group"><SelectValue placeholder="All markets" /></SelectTrigger><SelectContent><SelectItem value="all">All markets</SelectItem>{data.groups.map((group) => <SelectItem key={group.market} value={group.market}>{group.label}</SelectItem>)}</SelectContent></Select></div></div>
      <section aria-labelledby="market-coverage" className="space-y-2"><h2 id="market-coverage" className="text-base font-semibold">Fill rate by market</h2><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{groups.map((group) => <Card key={group.market}><CardHeader className="pb-2"><div className="flex items-center justify-between gap-2"><CardTitle className="text-sm">{group.label}</CardTitle><Badge variant={group.fillRate >= 0.8 ? "default" : "outline"}>{pct(group.fillRate)}</Badge></div></CardHeader><CardContent className="space-y-3"><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${group.fillRate * 100}%` }} /></div><div className="grid grid-cols-4 gap-2 text-center"><Small label="Signals" value={group.suggestions} /><Small label="Full" value={group.full} /><Small label="Part" value={group.partial} /><Small label="Missed" value={group.missed} /></div><p className="text-xs text-muted-foreground">Confidence {group.averageConfidence == null ? "—" : pct(group.averageConfidence)} · edge {group.averageExpectedEdgeBps == null ? "—" : `${group.averageExpectedEdgeBps.toFixed(0)} bps`} · missed {formatMoneySigned(group.missedProfitBase, data.currency)}</p></CardContent></Card>)}</div></section>
      <section aria-labelledby="missed-signals" className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 id="missed-signals" className="text-base font-semibold">Signals missed</h2><p className="text-xs text-muted-foreground">Expired opportunities with no complete fill, ranked by the money they would have made.</p></div><Select value={reason} onValueChange={setReason}><SelectTrigger className="w-[180px]" aria-label="Miss reason"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All reasons</SelectItem><SelectItem value="no_order">No broker order</SelectItem><SelectItem value="cancelled">Cancelled</SelectItem><SelectItem value="rejected">Rejected</SelectItem><SelectItem value="blocked">Blocked</SelectItem></SelectContent></Select></div>
        <div className="overflow-hidden rounded-md border border-border bg-card">{missed.length === 0 ? <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-positive" /> No missed signals match these filters.</div> : missed.map((row) => <div key={row.id} className="grid gap-3 border-b border-border px-4 py-3 last:border-b-0 md:grid-cols-[minmax(160px,1fr)_100px_100px_110px_minmax(220px,1.4fr)] md:items-center"><div><div className="font-medium">{row.symbol} <Badge variant="outline" className="ml-1 text-[10px]">{row.marketLabel}</Badge></div><div className="text-xs text-muted-foreground">{dateLabel(row.suggestedAt)} · {row.quantity} units</div></div><Value label="Confidence" value={pct(row.conviction)} /><Value label="Expected edge" value={`${row.expectedEdgeBps.toFixed(0)} bps`} /><Value label="Since signal" value={row.missedOutcomeBase == null ? "—" : formatMoneySigned(row.missedOutcomeBase, data.currency)} positive={(row.missedOutcomeBase ?? 0) > 0} /><div className="flex items-start gap-2 text-xs text-warning"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span><strong className="font-medium capitalize">{row.missReason?.replace("_", " ")}</strong><span className="mt-0.5 block text-muted-foreground">{row.reasonLabel}</span></span></div></div>)}</div>
      </section>
    </div>}
  </PageShell></>;
}

function Metric({ label, value, detail, attention = false }: { label: string; value: string; detail: string; attention?: boolean }) { return <Card><CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle></CardHeader><CardContent><div className={attention ? "text-2xl font-semibold text-warning" : "text-2xl font-semibold"}>{value}</div><p className="mt-1 text-xs text-muted-foreground">{detail}</p></CardContent></Card>; }
function Small({ label, value }: { label: string; value: number }) { return <div><div className="font-semibold tabular-nums">{value}</div><div className="text-[10px] text-muted-foreground">{label}</div></div>; }
function Value({ label, value, positive = false }: { label: string; value: string; positive?: boolean }) { return <div className="text-sm"><span className="mr-2 text-xs text-muted-foreground md:hidden">{label}</span><span className={positive ? "font-medium text-positive" : ""}>{value}</span></div>; }