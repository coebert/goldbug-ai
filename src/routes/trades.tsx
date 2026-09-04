import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { PageShell, PageSection } from "@/components/layout/page-shell";

const DecisionNewsBreakdown = lazy(() =>
  import("@/components/decision-news-breakdown").then((m) => ({ default: m.DecisionNewsBreakdown })),
);

import { useIsMobile } from "@/hooks/use-mobile";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { AppHeader } from "@/components/app-header";
import { Card, CardContent } from "@/components/ui/card";
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
} from "lucide-react";
import { getTradesDashboard, type TradeRow } from "@/lib/trades.functions";

export const Route = createFileRoute("/trades")({
  validateSearch: (search: Record<string, unknown>): { order?: string } => ({
    order: typeof search.order === "string" ? search.order : undefined,
  }),
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
  return d.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function TradesPage() {
  const { order: highlightOrderId } = Route.useSearch();
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
    <div className="min-h-screen overflow-x-hidden bg-surface-1">
      <AppHeader email={email} />
      <PageShell
        title="Trades"
        purpose="Every order's lifecycle — submitted, filled, rejected — alongside the position it moved."
        actions={
          <Button
            variant="outline"
            size="sm"
            className="min-h-11"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />
            <span className="ml-1.5">Refresh</span>
          </Button>
        }
      >


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

        <div className="sticky top-0 z-30 -mx-4 border-b border-border bg-background/90 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/70">
          <div className="flex items-center gap-2">
            <span className="hidden text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:inline">
              Filters
            </span>
            <div className="grid flex-1 grid-cols-2 gap-2 sm:ml-auto sm:flex sm:flex-1-none sm:flex-wrap sm:justify-end">
              <Select value={portfolioId} onValueChange={setPortfolioId}>
                <SelectTrigger className="h-9 w-full text-xs sm:w-[200px]">
                  <SelectValue placeholder="Portfolio" />
                </SelectTrigger>
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
                <SelectTrigger className="h-9 w-full text-xs sm:w-[140px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
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
                <SelectTrigger className="col-span-2 h-9 w-full text-xs sm:col-span-1 sm:w-[110px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="50">Last 50</SelectItem>
                  <SelectItem value="100">Last 100</SelectItem>
                  <SelectItem value="250">Last 250</SelectItem>
                  <SelectItem value="500">Last 500</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {(portfolioId !== "all" || status !== "all") && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>Active:</span>
              {portfolioId !== "all" && (
                <Badge variant="outline" className="text-[10px]">
                  {options.find(o => o.id === portfolioId)?.name ?? "Portfolio"}
                </Badge>
              )}
              {status !== "all" && (
                <Badge variant="outline" className="text-[10px]">{status}</Badge>
              )}
              <button
                type="button"
                onClick={() => { setPortfolioId("all"); setStatus("all"); }}
                className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Clear
              </button>
            </div>
          )}
        </div>


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
                  {group.map(row => <TradeCard key={row.order.id} row={row} highlight={row.order.id === highlightOrderId} />)}
                </div>
              </div>
            ))}
          </div>
        )}

        <PageSection
          id="why"
          title="Why the AI bought and sold"
          description="Each recent decision traced back to the news and signals behind it."
        >
          <Suspense fallback={<div className="skeleton-shimmer h-80 w-full" aria-hidden="true" />}>
            <DecisionNewsBreakdown />
          </Suspense>
        </PageSection>
      </PageShell>

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

function TradeCard({ row, highlight = false }: { row: TradeRow; highlight?: boolean }) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!highlight) return;
    // Scroll the linked trade into view and auto-expand its details.
    const t = setTimeout(() => {
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      setOpen(true);
    }, 100);
    return () => clearTimeout(t);
  }, [highlight]);
  const highlightCls = highlight ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : "";
  const buy = row.order.side.toLowerCase() === "buy";
  const fillPct = row.order.quantity > 0
    ? Math.min(100, (row.filledQty / row.order.quantity) * 100)
    : 0;

  const signedDelta = buy ? row.filledQty : -row.filledQty;
  const priorQty = row.holding ? row.holding.quantity - signedDelta : (signedDelta === 0 ? null : -signedDelta);
  const nowQty = row.holding?.quantity ?? (signedDelta === 0 ? 0 : signedDelta);

  // Track horizontal swipe on the summary row so a left-swipe opens details
  // as an alternative to tapping. Vertical scroll must still win.
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const swipeHandlers = isMobile
    ? {
        onTouchStart: (e: React.TouchEvent) => {
          const t = e.touches[0];
          touchStart.current = { x: t.clientX, y: t.clientY };
        },
        onTouchEnd: (e: React.TouchEvent) => {
          const start = touchStart.current;
          touchStart.current = null;
          if (!start) return;
          const t = e.changedTouches[0];
          const dx = t.clientX - start.x;
          const dy = t.clientY - start.y;
          if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            setOpen(true);
          }
        },
      }
    : {};

  const summary = (
    <div
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
      {...swipeHandlers}
    >
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
        {isMobile && (
          <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
            Tap or swipe ← for details
          </p>
        )}
      </div>
      <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open && !isMobile ? "rotate-180" : ""}`} />
    </div>
  );

  const feesTotal = row.fills.reduce((s, f) => s + f.fee, 0);
  const notional = row.notional ?? (row.avgFillPrice != null ? row.avgFillPrice * row.filledQty : 0);
  const cashFlow = buy ? -(notional + feesTotal) : notional - feesTotal;
  // Realized P&L estimate for sells (buys have no realized P&L on entry).
  const realizedPnl = !buy && row.holding && row.avgFillPrice != null && row.filledQty > 0
    ? (row.avgFillPrice - row.holding.avg_cost) * row.filledQty - feesTotal
    : null;
  const fillCurrency = row.fills[0]?.currency ?? "";

  const details = (
    <div className="space-y-3">
      {row.order.reject_reason && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-500">
          Reject reason: {row.order.reject_reason}
        </div>
      )}

      {row.filledQty > 0 && (
        <ImpactBreakdown
          buy={buy}
          priorQty={priorQty ?? 0}
          nowQty={nowQty}
          filledQty={row.filledQty}
          notional={notional}
          fees={feesTotal}
          cashFlow={cashFlow}
          realizedPnl={realizedPnl}
          currency={fillCurrency}
        />
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
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <ImpactCell label="Before" value={priorQty != null ? fmtNum(priorQty, 0) : "—"} />
              <ImpactCell
                label={buy ? "Bought" : "Sold"}
                value={row.filledQty > 0 ? `${buy ? "+" : "−"}${fmtNum(row.filledQty, 0)}` : "0"}
                tone={buy ? "good" : "bad"}
              />
              <ImpactCell label="After" value={fmtNum(nowQty, 0)} />
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 border-t border-border pt-2 text-[11px] text-muted-foreground sm:grid-cols-2">
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
                <Link to="/portfolio/$id/" params={{ id: row.portfolio.id }} className="text-primary underline-offset-2 hover:underline">
                  Open portfolio →
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <>
        <Card ref={cardRef} className={`overflow-hidden ${highlightCls}`}>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="block w-full hover:bg-muted/40"
          >
            {summary}
          </button>
        </Card>
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent className="max-h-[90dvh]">
            <DrawerHeader className="text-left">
              <DrawerTitle className="flex items-center gap-2 text-base">
                <span className={buy ? "text-emerald-500" : "text-red-500"}>
                  {row.order.side.toUpperCase()}
                </span>
                <span>{row.order.symbol}</span>
                {statusBadge(row.order.status)}
              </DrawerTitle>
              <DrawerDescription className="text-xs">
                {fmtNum(row.order.quantity, 0)} @ {row.order.order_type}
                {row.order.limit_price ? ` ${fmtNum(row.order.limit_price)}` : ""}
                {row.portfolio ? ` · ${row.portfolio.name} (${row.portfolio.mode})` : ""}
              </DrawerDescription>
            </DrawerHeader>
            <div className="overflow-y-auto px-4 pb-6">{details}</div>
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card ref={cardRef} className={`overflow-hidden ${highlightCls}`}>
        <CollapsibleTrigger asChild>
          <button className="block w-full text-left hover:bg-muted/40">
            {summary}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border bg-muted/20 px-3 py-3">
            {details}
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

function ImpactBreakdown({
  buy, priorQty, nowQty, filledQty, notional, fees, cashFlow, realizedPnl, currency,
}: {
  buy: boolean;
  priorQty: number;
  nowQty: number;
  filledQty: number;
  notional: number;
  fees: number;
  cashFlow: number;
  realizedPnl: number | null;
  currency: string;
}) {
  const cur = currency ? `${currency} ` : "";
  const feesPct = notional > 0 ? (fees / notional) * 100 : 0;
  // Position bar chart: before vs after, scaled to the larger of the two.
  const maxQty = Math.max(Math.abs(priorQty), Math.abs(nowQty), 1);
  const beforePct = Math.max(2, (Math.abs(priorQty) / maxQty) * 100);
  const afterPct = Math.max(2, (Math.abs(nowQty) / maxQty) * 100);
  // Notional vs fees stacked bar (fees are usually tiny — enforce a min visible width).
  const totalCost = notional + fees;
  const notionalPct = totalCost > 0 ? (notional / totalCost) * 100 : 100;
  const feesPctBar = totalCost > 0 ? Math.max(fees > 0 ? 2 : 0, (fees / totalCost) * 100) : 0;

  const cashTone = cashFlow >= 0 ? "text-emerald-500" : "text-red-500";
  const pnlTone = realizedPnl == null ? "text-foreground" : realizedPnl >= 0 ? "text-emerald-500" : "text-red-500";

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Impact breakdown
        </h4>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {buy ? "Buy" : "Sell"} · {fmtNum(filledQty, 0)} filled
        </span>
      </div>

      {/* Numeric tiles */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricTile label="Notional" value={`${cur}${fmtNum(notional)}`} />
        <MetricTile
          label="Fees"
          value={`${cur}${fmtNum(fees)}`}
          sub={notional > 0 ? `${feesPct.toFixed(2)}% of notional` : undefined}
        />
        <MetricTile
          label={buy ? "Cash used" : "Cash received"}
          value={`${cashFlow >= 0 ? "+" : "−"}${cur}${fmtNum(Math.abs(cashFlow))}`}
          toneClass={cashTone}
        />
        <MetricTile
          label="Realized P&L"
          value={realizedPnl == null ? "—" : `${realizedPnl >= 0 ? "+" : "−"}${cur}${fmtNum(Math.abs(realizedPnl))}`}
          toneClass={pnlTone}
          sub={realizedPnl == null && buy ? "Recognised on exit" : undefined}
        />
      </div>

      {/* Position before → after */}
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Position size</span>
          <span className="tabular-nums text-foreground">
            {fmtNum(priorQty, 0)} → {fmtNum(nowQty, 0)}
            <span className={`ml-1.5 ${buy ? "text-emerald-500" : "text-red-500"}`}>
              ({buy ? "+" : "−"}{fmtNum(filledQty, 0)})
            </span>
          </span>
        </div>
        <div className="space-y-1">
          <BarRow label="Before" pct={beforePct} tone="muted" />
          <BarRow label="After"  pct={afterPct}  tone={buy ? "good" : "bad"} />
        </div>
      </div>

      {/* Notional vs fees stacked bar */}
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Cost composition</span>
          <span className="tabular-nums text-foreground">
            {cur}{fmtNum(totalCost)}
          </span>
        </div>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-sky-500" style={{ width: `${notionalPct}%` }} />
          <div className="h-full bg-amber-500" style={{ width: `${feesPctBar}%` }} />
        </div>
        <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-sky-500" /> Notional
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-amber-500" /> Fees
          </span>
        </div>
      </div>
    </div>
  );
}

function MetricTile({ label, value, sub, toneClass }: { label: string; value: string; sub?: string; toneClass?: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${toneClass ?? "text-foreground"}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function BarRow({ label, pct, tone }: { label: string; pct: number; tone: "good" | "bad" | "muted" }) {
  const fill = tone === "good" ? "bg-emerald-500" : tone === "bad" ? "bg-red-500" : "bg-muted-foreground/40";
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${fill}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
    </div>
  );
}

