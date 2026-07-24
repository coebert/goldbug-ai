import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { AppHeader } from "@/components/app-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowDownUp,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock,
  RefreshCw,
  XCircle,
  AlertTriangle,
  ArrowLeft,
} from "lucide-react";
import { getTradesDashboard, type TradeRow } from "@/lib/trades.functions";

export const Route = createFileRoute("/trades")({
  head: () => ({
    meta: [
      { title: "Trades — Aegis" },
      { name: "description", content: "Order lifecycle and position impact across every portfolio." },
      { property: "og:title", content: "Trades — Aegis" },
      { property: "og:description", content: "Order lifecycle and position impact across every portfolio." },
    ],
  }),
  component: TradesPage,
});

type StatusKind = "filled" | "partial" | "submitted" | "rejected" | "errored" | "skipped" | "other";

function classifyStatus(status: string): StatusKind {
  const s = (status ?? "").toLowerCase();
  if (s === "filled") return "filled";
  if (s === "partial" || s === "partially_filled") return "partial";
  if (s === "submitted" || s === "accepted" || s === "working") return "submitted";
  if (s === "rejected") return "rejected";
  if (s === "error" || s === "errored") return "errored";
  if (s === "skipped") return "skipped";
  return "other";
}

function statusBadge(status: string) {
  const kind = classifyStatus(status);
  const map: Record<StatusKind, { label: string; className: string; icon: React.ReactNode }> = {
    filled:    { label: status, className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-500", icon: <CheckCircle2 className="h-3 w-3" /> },
    partial:   { label: status, className: "border-amber-500/40 bg-amber-500/10 text-amber-500", icon: <CheckCircle2 className="h-3 w-3" /> },
    submitted: { label: status, className: "border-sky-500/40 bg-sky-500/10 text-sky-500", icon: <Clock className="h-3 w-3" /> },
    rejected:  { label: status, className: "border-red-500/40 bg-red-500/10 text-red-500", icon: <XCircle className="h-3 w-3" /> },
    errored:   { label: status, className: "border-red-500/40 bg-red-500/10 text-red-500", icon: <AlertTriangle className="h-3 w-3" /> },
    skipped:   { label: status, className: "border-muted-foreground/40 bg-muted text-muted-foreground", icon: <Circle className="h-3 w-3" /> },
    other:     { label: status, className: "border-border bg-muted text-foreground", icon: <Circle className="h-3 w-3" /> },
  };
  const s = map[kind];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${s.className}`}>
      {s.icon}
      {s.label}
    </span>
  );
}

function fmtNum(n: number | null | undefined, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function TradesPage() {
  const [email, setEmail] = useState<string | null>(null);
  const [portfolioId, setPortfolioId] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [limit, setLimit] = useState<number>(100);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);

  const fetchTrades = useServerFn(getTradesDashboard);
  const query = useQuery({
    queryKey: ["trades-dashboard", portfolioId, status, limit],
    queryFn: () => fetchTrades({
      data: {
        limit,
        portfolioId: portfolioId === "all" ? null : portfolioId,
        status: status === "all" ? null : status,
      },
    }),
    refetchOnWindowFocus: false,
  });

  const rows = query.data?.rows ?? [];
  const summary = query.data?.summary;
  const options = query.data?.portfolioOptions ?? [];

  const groupedByRun = useMemo(() => {
    // Group rows by created_at bucket (nearest minute) to make runs visible.
    const bucket = new Map<string, TradeRow[]>();
    for (const r of rows) {
      const t = new Date(r.order.created_at);
      t.setSeconds(0, 0);
      const k = t.toISOString();
      const arr = bucket.get(k) ?? [];
      arr.push(r);
      bucket.set(k, arr);
    }
    return Array.from(bucket.entries())
      .sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [rows]);

  return (
    <div className="min-h-screen bg-background">
      <AppHeader email={email} />
      <main className="mx-auto max-w-6xl px-4 py-6 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" /> Dashboard
            </Link>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />
            <span className="ml-1.5">Refresh</span>
          </Button>
        </div>

        <div>
          <h1 className="text-xl font-semibold leading-tight tracking-tight sm:text-2xl">Trades</h1>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground sm:text-sm">
            Every order's lifecycle — submitted, filled, rejected — alongside the current position it moved.
          </p>
        </div>

        {summary && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            <SummaryTile label="Total" value={summary.total} tone="neutral" />
            <SummaryTile label="Filled" value={summary.filled} tone="good" />
            <SummaryTile label="Partial" value={summary.partial} tone="warn" />
            <SummaryTile label="Working" value={summary.submitted} tone="info" />
            <SummaryTile label="Rejected" value={summary.rejected} tone="bad" />
            <SummaryTile label="Errored" value={summary.errored} tone="bad" />
            <SummaryTile label="Skipped" value={summary.skipped} tone="muted" />
          </div>
        )}

        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">Filters</CardTitle>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Select value={portfolioId} onValueChange={setPortfolioId}>
                  <SelectTrigger className="h-8 w-[200px] text-xs"><SelectValue placeholder="Portfolio" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All portfolios</SelectItem>
                    {options.map(o => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.name} <span className="text-muted-foreground">({o.mode})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue placeholder="Status" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="filled">Filled</SelectItem>
                    <SelectItem value="partial">Partial</SelectItem>
                    <SelectItem value="submitted">Submitted</SelectItem>
                    <SelectItem value="rejected">Rejected</SelectItem>
                    <SelectItem value="error">Errored</SelectItem>
                    <SelectItem value="skipped">Skipped</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
                  <SelectTrigger className="h-8 w-[110px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="50">Last 50</SelectItem>
                    <SelectItem value="100">Last 100</SelectItem>
                    <SelectItem value="250">Last 250</SelectItem>
                    <SelectItem value="500">Last 500</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardHeader>
        </Card>

        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading trades…</p>
        ) : query.isError ? (
          <p className="text-sm text-red-500">Failed to load trades.</p>
        ) : rows.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No orders yet for the selected filters.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {groupedByRun.map(([runKey, group]) => (
              <div key={runKey} className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <ArrowDownUp className="h-3.5 w-3.5" />
                  <span>Run · {fmtTime(runKey)}</span>
                  <span>·</span>
                  <span>{group.length} order{group.length === 1 ? "" : "s"}</span>
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {group.map(row => <TradeCard key={row.order.id} row={row} />)}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: number; tone: "good" | "bad" | "warn" | "info" | "muted" | "neutral" }) {
  const toneMap = {
    good:    "text-emerald-500",
    bad:     "text-red-500",
    warn:    "text-amber-500",
    info:    "text-sky-500",
    muted:   "text-muted-foreground",
    neutral: "text-foreground",
  } as const;
  return (
    <Card>
      <CardContent className="px-3 py-2.5">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={`text-lg font-semibold leading-tight sm:text-xl ${toneMap[tone]}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

function TradeCard({ row }: { row: TradeRow }) {
  const [open, setOpen] = useState(false);
  const buy = row.order.side.toLowerCase() === "buy";
  const fillPct = row.order.quantity > 0
    ? Math.min(100, (row.filledQty / row.order.quantity) * 100)
    : 0;

  const signedDelta = buy ? row.filledQty : -row.filledQty;
  const priorQty = row.holding ? row.holding.quantity - signedDelta : (signedDelta === 0 ? null : -signedDelta);
  const nowQty = row.holding?.quantity ?? (signedDelta === 0 ? 0 : signedDelta);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className="overflow-hidden">
        <CollapsibleTrigger asChild>
          <button className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40">
            <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${buy ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500"}`}>
              {buy ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{row.order.symbol}</span>
                <span className="text-xs uppercase text-muted-foreground">{row.order.side}</span>
                <span className="text-xs text-muted-foreground">{fmtNum(row.order.quantity, 0)} @ {row.order.order_type}{row.order.limit_price ? ` ${fmtNum(row.order.limit_price)}` : ""}</span>
                {statusBadge(row.order.status)}
                {row.portfolio && (
                  <Badge variant="outline" className="text-[10px]">
                    {row.portfolio.name} · {row.portfolio.mode}
                  </Badge>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                <span>Created {fmtTime(row.order.created_at)}</span>
                {row.order.submitted_at && <span>· Submitted {fmtTime(row.order.submitted_at)}</span>}
                <span>· Filled {fmtNum(row.filledQty, 0)}/{fmtNum(row.order.quantity, 0)}</span>
                {row.avgFillPrice != null && <span>· Avg {fmtNum(row.avgFillPrice)}</span>}
                {row.holding
                  ? <span>· Position now {fmtNum(row.holding.quantity, 0)} @ {fmtNum(row.holding.avg_cost)}</span>
                  : <span>· No open position</span>}
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full ${fillPct >= 100 ? "bg-emerald-500" : fillPct > 0 ? "bg-amber-500" : "bg-muted-foreground/30"}`}
                  style={{ width: `${Math.max(2, fillPct)}%` }}
                />
              </div>
            </div>
            <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border px-3 py-3 space-y-3 bg-muted/20">
            {row.order.reject_reason && (
              <div className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-500">
                Reject reason: {row.order.reject_reason}
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {/* Lifecycle timeline */}
              <div>
                <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lifecycle</h4>
                <ol className="space-y-1 text-xs">
                  <Step label="Created" at={row.order.created_at} state="done" />
                  <Step label="Submitted to broker" at={row.order.submitted_at} state={row.order.submitted_at ? "done" : "pending"} />
                  {row.fills.length > 0
                    ? row.fills.map((f, i) => (
                        <Step
                          key={f.id}
                          label={`Fill ${i + 1} · ${fmtNum(f.quantity, 0)} @ ${fmtNum(f.fill_price)} ${f.currency}`}
                          at={f.filled_at}
                          state="done"
                        />
                      ))
                    : classifyStatus(row.order.status) === "rejected"
                      ? <Step label="Rejected" at={row.order.updated_at} state="bad" />
                      : classifyStatus(row.order.status) === "errored"
                        ? <Step label="Errored" at={row.order.updated_at} state="bad" />
                        : <Step label="Awaiting fills" at={null} state="pending" />}
                  <Step label={`Final · ${row.order.status}`} at={row.order.updated_at} state={
                    ["filled", "partial"].includes(classifyStatus(row.order.status)) ? "done"
                      : ["rejected", "errored"].includes(classifyStatus(row.order.status)) ? "bad"
                      : "pending"
                  } />
                </ol>
              </div>

              {/* Position impact */}
              <div>
                <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Position impact</h4>
                <div className="rounded-md border border-border bg-background px-2.5 py-2 text-xs">
                  <div className="grid grid-cols-3 gap-2">
                    <ImpactCell label="Before" value={priorQty != null ? fmtNum(priorQty, 0) : "—"} />
                    <ImpactCell
                      label={buy ? "Bought" : "Sold"}
                      value={row.filledQty > 0 ? `${buy ? "+" : "−"}${fmtNum(row.filledQty, 0)}` : "0"}
                      tone={buy ? "good" : "bad"}
                    />
                    <ImpactCell label="After" value={fmtNum(nowQty, 0)} />
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
                    <div>Avg cost now: <span className="text-foreground">{row.holding ? fmtNum(row.holding.avg_cost) : "—"}</span></div>
                    <div>Fill notional: <span className="text-foreground">{row.notional != null ? fmtNum(row.notional) : "—"}</span></div>
                    <div>Fees: <span className="text-foreground">{fmtNum(row.fills.reduce((s, f) => s + f.fee, 0))}</span></div>
                    <div>Last update: <span className="text-foreground">{fmtTime(row.holding?.updated_at ?? row.order.updated_at)}</span></div>
                  </div>
                  {!row.holding && row.filledQty > 0 && (
                    <p className="mt-2 text-[11px] text-amber-500">
                      Order shows fills but no matching holding row — position may still be syncing.
                    </p>
                  )}
                </div>

                <div className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
                  <div>Broker: <span className="text-foreground">{row.order.broker}</span></div>
                  {row.order.broker_order_id && <div>Broker ID: <span className="font-mono text-foreground">{row.order.broker_order_id}</span></div>}
                  {row.order.client_order_id && <div>Client ID: <span className="font-mono text-foreground">{row.order.client_order_id}</span></div>}
                  {row.portfolio && (
                    <div>
                      <Link to="/portfolio/$id" params={{ id: row.portfolio.id }} className="text-primary underline-offset-2 hover:underline">
                        Open portfolio →
                      </Link>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function Step({ label, at, state }: { label: string; at: string | null | undefined; state: "done" | "pending" | "bad" }) {
  const dot =
    state === "done" ? "bg-emerald-500"
    : state === "bad" ? "bg-red-500"
    : "bg-muted-foreground/40";
  return (
    <li className="flex items-start gap-2">
      <span className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="flex-1">
        <span className="text-foreground">{label}</span>
        {at && <span className="ml-1.5 text-muted-foreground">· {fmtTime(at)}</span>}
      </span>
    </li>
  );
}

function ImpactCell({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  const toneCls = tone === "good" ? "text-emerald-500" : tone === "bad" ? "text-red-500" : "text-foreground";
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-sm font-semibold ${toneCls}`}>{value}</p>
    </div>
  );
}
