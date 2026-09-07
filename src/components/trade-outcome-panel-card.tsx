import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getTradeOutcomes,
  type TradeOutcomeRow,
} from "@/lib/trade-outcomes.functions";
import { summarizeOutcomes } from "@/lib/trade-outcome-summary";
import { supabase } from "@/integrations/supabase/client";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Activity,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  CircleDashed,
  TrendingDown,
  Target,
  AlertTriangle,
} from "lucide-react";
import { explainOrderOutcome, isExpectedNonFill } from "@/lib/order-cancel-explain";
import { formatUkTime } from "@/lib/uk-time";
import { cn } from "@/lib/utils";

interface Props {
  portfolioId: string;
  active?: boolean;
}

type Bucket = "all" | "working" | "filled" | "failed";

const STATUS_STYLE: Record<
  string,
  { label: string; className: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  filled: {
    label: "Filled",
    className: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
    Icon: CheckCircle2,
  },
  partially_filled: {
    label: "Partial",
    className: "bg-sky-500/15 text-sky-500 border-sky-500/30",
    Icon: CircleDashed,
  },
  working: {
    label: "Working",
    className: "bg-amber-500/15 text-amber-500 border-amber-500/30",
    Icon: Clock,
  },
  pending: {
    label: "Pending",
    className: "bg-muted text-muted-foreground border-border",
    Icon: Clock,
  },
  submitted: {
    label: "Submitted",
    className: "bg-amber-500/15 text-amber-500 border-amber-500/30",
    Icon: Clock,
  },
  rejected: {
    label: "Rejected",
    className: "bg-destructive/15 text-destructive border-destructive/30",
    Icon: XCircle,
  },
  error: {
    label: "Error",
    className: "bg-destructive/15 text-destructive border-destructive/30",
    Icon: XCircle,
  },
  cancelled: {
    label: "Cancelled",
    className: "bg-muted text-muted-foreground border-border",
    Icon: XCircle,
  },
};

function bucketOf(status: string, reason?: string | null): Bucket {
  if (status === "filled" || status === "partially_filled") return "filled";
  if (status === "rejected" || status === "error") return "failed";
  if (status === "cancelled") return isExpectedNonFill(status, reason) ? "working" : "failed";
  return "working";
}

function formatQty(q: number) {
  return q.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatPrice(p: number | null, ccy: string) {
  if (p == null) return "—";
  return `${p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${ccy}`;
}

/**
 * Real-time trade outcome panel. Streams `live_orders` + `live_fills` changes
 * via Realtime and re-fetches the server view so each attempted order shows
 * its current status, fills, error reason, and timestamps.
 */
export function TradeOutcomePanelCard({ portfolioId, active = true }: Props) {
  const fetchOutcomes = useServerFn(getTradeOutcomes);
  const qc = useQueryClient();

  const [windowHours, setWindowHours] = useState<number>(24);
  const queryKey = ["trade-outcomes", portfolioId, windowHours] as const;

  const query = useQuery({
    queryKey,
    queryFn: () =>
      fetchOutcomes({ data: { portfolioId, sinceHours: windowHours, limit: 200 } }),
    enabled: active,
    staleTime: 15_000,
    refetchInterval: active ? 30_000 : false,
  });

  const [bucket, setBucket] = useState<Bucket>("all");
  const [flash, setFlash] = useState<Set<string>>(new Set());
  // Prevents duplicate toasts when Realtime re-delivers the same UPDATE
  // (e.g. reconnects) or when we cross a terminal boundary more than once.
  const toastedRef = useRef<Set<string>>(new Set());

  // Realtime: any change to this portfolio's orders or fills → refetch and
  // flash the affected order card briefly.
  useEffect(() => {
    if (!active) return;
    const channel = supabase
      .channel(`trade-outcomes:${portfolioId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "live_orders",
          filter: `portfolio_id=eq.${portfolioId}`,
        },
        (payload) => {
          const newRow = payload.new as {
            id?: string;
            status?: string;
            symbol?: string;
            side?: string;
            broker_order_id?: string | null;
            reject_reason?: string | null;
          } | null;
          const oldRow = payload.old as { id?: string; status?: string } | null;
          const id = newRow?.id ?? oldRow?.id;

          // Toast on state transition into a terminal status.
          if (
            payload.eventType === "UPDATE" &&
            id &&
            newRow?.status &&
            oldRow?.status &&
            newRow.status !== oldRow.status
          ) {
            maybeToastTransition({
              orderId: id,
              prev: oldRow.status,
              next: newRow.status,
              symbol: newRow.symbol ?? "—",
              side: newRow.side ?? "",
              brokerOrderId: newRow.broker_order_id ?? null,
              rejectReason: newRow.reject_reason ?? null,
              toastedRef,
            });
          }

          if (id) {
            setFlash((prev) => {
              const next = new Set(prev);
              next.add(id);
              return next;
            });
            window.setTimeout(() => {
              setFlash((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
              });
            }, 2500);
          }
          qc.invalidateQueries({ queryKey });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "live_fills",
          filter: `portfolio_id=eq.${portfolioId}`,
        },
        (payload) => {
          const orderId = (payload.new as { order_id?: string } | null)
            ?.order_id;
          if (orderId) {
            setFlash((prev) => {
              const next = new Set(prev);
              next.add(orderId);
              return next;
            });
            window.setTimeout(() => {
              setFlash((prev) => {
                const next = new Set(prev);
                next.delete(orderId);
                return next;
              });
            }, 2500);
          }
          qc.invalidateQueries({ queryKey });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [active, portfolioId, qc]);

  const rows = query.data?.rows ?? [];
  const counts = query.data?.counts ?? {};
  const summary = useMemo(() => summarizeOutcomes(rows), [rows]);
  const filtered = useMemo(() => {
    if (bucket === "all") return rows;
    return rows.filter((r) => bucketOf(r.status, r.rejectReason) === bucket);
  }, [rows, bucket]);

  const WINDOWS: { hours: number; label: string }[] = [
    { hours: 1, label: "1h" },
    { hours: 6, label: "6h" },
    { hours: 24, label: "24h" },
    { hours: 24 * 7, label: "7d" },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-primary" />
              Trade outcomes (live)
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Attempted orders in the selected window. Streams updates as Saxo
              fills or rejects each order.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <div
              role="tablist"
              aria-label="Time window"
              className="hidden sm:flex rounded-md border border-border bg-background p-0.5"
            >
              {WINDOWS.map((w) => (
                <button
                  key={w.hours}
                  role="tab"
                  aria-selected={windowHours === w.hours}
                  onClick={() => setWindowHours(w.hours)}
                  className={cn(
                    "rounded px-2 py-1 text-xs transition-colors",
                    windowHours === w.hours
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {w.label}
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
              aria-label="Refresh trade outcomes"
            >
              <RefreshCw
                className={cn(
                  "h-4 w-4",
                  query.isFetching && "animate-spin",
                )}
              />
            </Button>
          </div>
        </div>

        {/* Mobile window selector */}
        <div
          role="tablist"
          aria-label="Time window"
          className="mt-2 flex sm:hidden rounded-md border border-border bg-background p-0.5 w-fit"
        >
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              role="tab"
              aria-selected={windowHours === w.hours}
              onClick={() => setWindowHours(w.hours)}
              className={cn(
                "rounded px-2 py-1 text-xs transition-colors",
                windowHours === w.hours
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {w.label}
            </button>
          ))}
        </div>

        <SummaryTiles summary={summary} />


        <div
          role="tablist"
          aria-label="Filter by outcome"
          className="mt-3 flex flex-wrap gap-1.5"
        >
          {(
            [
              { key: "all", label: `All (${rows.length})` },
              {
                key: "working",
                label: `Working (${(counts.working ?? 0) + (counts.partial ?? 0)})`,
              },
              { key: "filled", label: `Filled (${counts.filled ?? 0})` },
              {
                key: "failed",
                label: `Failed (${(counts.failed ?? 0) + (counts.cancelled ?? 0)})`,
              },
            ] as const
          ).map((b) => (
            <button
              key={b.key}
              role="tab"
              aria-selected={bucket === b.key}
              onClick={() => setBucket(b.key as Bucket)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                bucket === b.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              {b.label}
            </button>
          ))}
        </div>
      </CardHeader>

      <CardContent className="space-y-2">
        {query.isLoading && (
          <p className="text-sm text-muted-foreground">Loading outcomes…</p>
        )}
        {!query.isLoading && filtered.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No orders in this bucket yet.
          </p>
        )}
        {filtered.map((row) => (
          <OutcomeRow
            key={row.id}
            row={row}
            flashing={flash.has(row.id)}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function OutcomeRow({
  row,
  flashing,
}: {
  row: TradeOutcomeRow;
  flashing: boolean;
}) {
  const explain = explainOrderOutcome(row.status, row.rejectReason);
  const baseStyle = STATUS_STYLE[row.status] ?? {
    label: row.status,
    className: "bg-muted text-muted-foreground border-border",
    Icon: CircleDashed,
  };
  const style = explain
    ? {
        label: explain.label,
        className: "bg-muted text-muted-foreground border-border",
        Icon: CircleDashed,
      }
    : baseStyle;
  const Icon = style.Icon;
  const isBuy = row.side === "buy";
  const lastEventAt = row.fills.at(-1)?.filledAt ?? row.updatedAt;

  return (
    <div
      className={cn(
        "rounded-lg border bg-card/60 p-3 transition-colors",
        flashing && "ring-2 ring-primary/50 bg-primary/5",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              "px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide",
              isBuy
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
                : "border-rose-500/40 bg-rose-500/10 text-rose-500",
            )}
          >
            {row.side}
          </Badge>
          <span className="font-semibold text-sm">{row.symbol}</span>
          <span className="text-xs text-muted-foreground">
            {formatQty(row.quantity)} @{" "}
            {row.orderType === "limit"
              ? formatPrice(row.limitPrice, row.instrumentCcy)
              : `mkt ${row.instrumentCcy}`}
          </span>
        </div>
        <Badge
          variant="outline"
          className={cn("gap-1 text-[11px]", style.className)}
        >
          <Icon className="h-3 w-3" />
          {style.label}
        </Badge>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
        <div>
          <div className="text-[10px] uppercase tracking-wide">Created</div>
          <div className="text-foreground">
            {formatUkTime(row.createdAt)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide">Submitted</div>
          <div className="text-foreground">
            {row.submittedAt
              ? formatUkTime(row.submittedAt)
              : "—"}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide">Last event</div>
          <div className="text-foreground">
            {formatUkTime(lastEventAt)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide">Filled</div>
          <div className="text-foreground">
            {formatQty(row.filledQty)} / {formatQty(row.quantity)}
            {row.avgFillPrice != null && (
              <span className="ml-1 text-muted-foreground">
                @ {formatPrice(row.avgFillPrice, row.instrumentCcy)}
              </span>
            )}
          </div>
        </div>
      </div>

      {row.brokerOrderId && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          Broker order:{" "}
          <span className="font-mono text-foreground">{row.brokerOrderId}</span>
        </div>
      )}

      {explain && (
        <div className="mt-2 rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">
            No trade happened — this is not an error.{" "}
          </span>
          {explain.plain}
          {row.rejectReason && (
            <span className="mt-1 block break-all font-mono text-[10px] opacity-70">
              {truncateReason(row.rejectReason, 160)}
            </span>
          )}
        </div>
      )}

      {!explain && row.rejectReason && (
        <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          <span className="font-semibold">Reason: </span>
          <span className="break-all font-mono text-[11px]">
            {truncateReason(row.rejectReason)}
          </span>
        </div>
      )}

      {row.fills.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            {row.fills.length} fill{row.fills.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 space-y-1">
            {row.fills.map((f) => (
              <li
                key={f.id}
                className="flex items-center justify-between rounded bg-muted/40 px-2 py-1"
              >
                <span className="text-foreground">
                  {formatQty(f.quantity)} @ {formatPrice(f.price, f.currency)}
                </span>
                <span className="text-muted-foreground">
                  {formatUkTime(f.filledAt)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function truncateReason(reason: string, max = 260): string {
  const trimmed = reason.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

const NON_TERMINAL_STATUSES = new Set([
  "pending",
  "submitted",
  "working",
]);
const SUCCESS_STATUSES = new Set(["filled", "partially_filled"]);
const FAILURE_STATUSES = new Set(["rejected", "error", "cancelled"]);

function maybeToastTransition(args: {
  orderId: string;
  prev: string;
  next: string;
  symbol: string;
  side: string;
  brokerOrderId: string | null;
  rejectReason: string | null;
  toastedRef: React.MutableRefObject<Set<string>>;
}) {
  const { orderId, prev, next, symbol, side, brokerOrderId, rejectReason, toastedRef } = args;

  const wasNonTerminal = NON_TERMINAL_STATUSES.has(prev);
  const nowSuccess = SUCCESS_STATUSES.has(next);
  const nowFailure = FAILURE_STATUSES.has(next);
  if (!wasNonTerminal || (!nowSuccess && !nowFailure)) return;

  const key = `${orderId}:${next}`;
  if (toastedRef.current.has(key)) return;
  toastedRef.current.add(key);

  const sideLabel = side ? side.toUpperCase() : "";
  const expected = explainOrderOutcome(next, rejectReason);
  const title = nowSuccess
    ? `${sideLabel} ${symbol} ${next === "partially_filled" ? "partially filled" : "filled"}`
    : expected
      ? `${sideLabel} ${symbol} — ${expected.label.toLowerCase()}`
      : `${sideLabel} ${symbol} failed`;

  const brokerLine = brokerOrderId
    ? `Broker order: ${brokerOrderId}`
    : "Broker order: (none assigned)";
  const description = expected
    ? `${expected.plain} ${brokerLine}`
    : rejectReason
      ? `${brokerLine} · ${truncateReason(rejectReason, 140)}`
      : brokerLine;

  if (nowSuccess) {
    toast.success(title, { description, duration: 6000 });
  } else if (expected) {
    toast.info(title, { description, duration: 7000 });
  } else {
    toast.error(title, { description, duration: 8000 });
  }
}


function SummaryTiles({
  summary,
}: {
  summary: ReturnType<typeof summarizeOutcomes>;
}) {
  const fmtPct = (n: number) =>
    `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  const fmtBps = (n: number | null) => {
    if (n == null) return "—";
    const rounded = Math.round(n * 10) / 10;
    const sign = rounded > 0 ? "+" : "";
    return `${sign}${rounded.toLocaleString(undefined, { maximumFractionDigits: 1 })} bps`;
  };
  const slippageTone =
    summary.avgSlippageBps == null
      ? "text-foreground"
      : summary.avgSlippageBps > 5
        ? "text-rose-500"
        : summary.avgSlippageBps < -1
          ? "text-emerald-500"
          : "text-foreground";
  const errorTone =
    summary.errorCount > 0 ? "text-destructive" : "text-foreground";

  return (
    <div
      className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"
      aria-label="Trade outcome summary"
    >
      <Tile
        icon={<Target className="h-3.5 w-3.5" />}
        label="Fill rate"
        value={summary.total > 0 ? fmtPct(summary.fillRatePct) : "—"}
        sub={`${summary.filled + summary.partial}/${summary.total} orders`}
      />
      <Tile
        icon={<Activity className="h-3.5 w-3.5" />}
        label="Volume filled"
        value={summary.total > 0 ? fmtPct(summary.volumeFillRatePct) : "—"}
        sub="Σ filled qty ÷ requested"
      />
      <Tile
        icon={<TrendingDown className="h-3.5 w-3.5" />}
        label="Avg slippage"
        value={fmtBps(summary.avgSlippageBps)}
        sub={
          summary.slippageSampleCount > 0
            ? `${summary.slippageSampleCount} limit ${summary.slippageSampleCount === 1 ? "order" : "orders"}`
            : "No limit fills"
        }
        valueClassName={slippageTone}
      />
      <Tile
        icon={<AlertTriangle className="h-3.5 w-3.5" />}
        label="Errors"
        value={String(summary.errorCount)}
        sub={
          summary.cancelledCount > 0
            ? `${summary.cancelledCount} cancelled`
            : "rejected + error"
        }
        valueClassName={errorTone}
      />
    </div>
  );
}

function Tile({
  icon,
  label,
  value,
  sub,
  valueClassName,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/60 p-2.5">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={cn("mt-1 text-lg font-semibold tabular-nums", valueClassName)}>
        {value}
      </div>
      <div className="text-[10px] text-muted-foreground">{sub}</div>
    </div>
  );
}

