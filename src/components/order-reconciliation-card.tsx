import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listRecentOrderReconciliation,
  type ReconOrderRow,
} from "@/lib/order-reconciliation-view.functions";
import {
  backfillOrderReconciliation,
  type BackfillResult,
} from "@/lib/order-reconciliation-backfill.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ClipboardCheck, PlayCircle, RefreshCw } from "lucide-react";
import { formatUkTime } from "@/lib/uk-time";
import {
  getMarketStatusForSymbol,
  getMarketStatusOverview,
  inferVenue,
  type MarketStatus,
} from "@/lib/market-hours";
import { toast } from "sonner";

const RANGES = [
  { label: "24h", hours: 24 },
  { label: "3d", hours: 72 },
  { label: "7d", hours: 24 * 7 },
] as const;

const STATUS_FILTERS = ["all", "filled", "submitted", "working", "partial", "error", "rejected", "cancelled"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function statusVariant(status: string): { cls: string; label: string } {
  const s = status.toLowerCase();
  if (s === "filled") return { cls: "bg-emerald-600 text-white hover:bg-emerald-600", label: "filled" };
  if (s === "partial") return { cls: "bg-blue-600 text-white hover:bg-blue-600", label: "partial" };
  if (s === "submitted" || s === "working" || s === "pending")
    return { cls: "bg-amber-500 text-white hover:bg-amber-500", label: s };
  if (s === "rejected" || s === "error")
    return { cls: "bg-destructive text-destructive-foreground", label: s };
  return { cls: "bg-muted text-muted-foreground", label: s };
}

function fmtLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m ${rs}s`;
}

export function OrderReconciliationCard({ portfolioId }: { portfolioId?: string } = {}) {
  const fetchRows = useServerFn(listRecentOrderReconciliation);
  const [hours, setHours] = useState<number>(72);
  const [status, setStatus] = useState<StatusFilter>("all");
  const queryClient = useQueryClient();
  const runBackfill = useServerFn(backfillOrderReconciliation);

  const q = useQuery({
    queryKey: ["order-recon-view", hours, portfolioId ?? null],
    queryFn: () => fetchRows({ data: { hours, portfolioId } }),
    refetchInterval: 60_000,
  });

  const backfill = useMutation({
    mutationFn: () =>
      runBackfill({ data: { lookbackHours: 24 * 60, includeError: true, portfolioId } }),
    onSuccess: (res: BackfillResult) => {
      const t = res.totals;
      const failed = res.portfolios.filter((p) => !p.ok).length;
      toast.success(
        `Backfill complete: ${t.filled} filled · ${t.partial} partial · ${t.rejected} rejected · ${t.cancelled} cancelled · ${t.stillWorking} still working · ${t.unknown} unknown` +
          (failed ? ` · ${failed} portfolio error${failed === 1 ? "" : "s"}` : ""),
        { duration: 8000 },
      );
      queryClient.invalidateQueries({ queryKey: ["order-recon-view"] });
    },
    onError: (e: unknown) =>
      toast.error(`Backfill failed: ${e instanceof Error ? e.message : String(e)}`),
  });

  const rows: ReconOrderRow[] = q.data ?? [];
  const filtered = useMemo(
    () => (status === "all" ? rows : rows.filter((r) => r.status.toLowerCase() === status)),
    [rows, status],
  );

  const summary = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status.toLowerCase()] = (counts[r.status.toLowerCase()] ?? 0) + 1;
    const filled = rows.filter((r) => r.first_fill_at);
    const avgLatency =
      filled.length > 0
        ? filled.reduce((a, r) => a + (r.latency_ms ?? 0), 0) / filled.length
        : null;
    return { counts, total: rows.length, filledCount: filled.length, avgLatency };
  }, [rows]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardCheck className="h-4 w-4 text-primary" /> Order reconciliation
        </CardTitle>
        <div className="flex flex-wrap items-center gap-1">
          {RANGES.map((r) => (
            <Button
              key={r.hours}
              size="sm"
              variant={hours === r.hours ? "default" : "outline"}
              onClick={() => setHours(r.hours)}
            >
              {r.label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="outline"
            onClick={() => backfill.mutate()}
            disabled={backfill.isPending}
            title="Re-check every open/error order against Saxo over the last 60 days"
          >
            <PlayCircle className={`mr-1 h-3.5 w-3.5 ${backfill.isPending ? "animate-pulse" : ""}`} />
            {backfill.isPending ? "Backfilling…" : "Backfill"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isError && (
          <div className="text-sm text-destructive">
            Failed to load: {(q.error as Error).message}
          </div>
        )}
        <MarketStatusStrip />


        {rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">
              {summary.total} orders · {summary.filledCount} filled · avg fill latency{" "}
              <span className="font-medium text-foreground">{fmtLatency(summary.avgLatency)}</span>
            </span>
            <div className="ml-auto flex flex-wrap gap-1">
              {STATUS_FILTERS.map((s) => {
                const count = s === "all" ? summary.total : summary.counts[s] ?? 0;
                if (s !== "all" && count === 0) return null;
                return (
                  <Button
                    key={s}
                    size="sm"
                    variant={status === s ? "default" : "outline"}
                    className="h-7 px-2 text-xs capitalize"
                    onClick={() => setStatus(s)}
                  >
                    {s} <span className="ml-1 tabular-nums opacity-70">{count}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Submitted</TableHead>
                <TableHead>Portfolio</TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead>Side</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>First fill</TableHead>
                <TableHead className="text-right">Fill latency</TableHead>
                <TableHead className="text-right">Filled / avg px</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && !q.isLoading && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-sm text-muted-foreground">
                    No orders in this window.
                  </TableCell>
                </TableRow>
              )}
              {filtered.slice(0, 100).map((r) => {
                const sv = statusVariant(r.status);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatUkTime(r.submitted_at ?? r.created_at)}
                    </TableCell>
                    <TableCell className="text-xs">{r.portfolio_name ?? "—"}</TableCell>
                    <TableCell className="font-medium">{r.symbol}</TableCell>
                    <TableCell className="uppercase text-xs">{r.side}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.quantity}</TableCell>
                    <TableCell>
                      <Badge className={sv.cls}>{sv.label}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {r.first_fill_at ? formatUkTime(r.first_fill_at) : (
                        <span className="text-muted-foreground">not filled</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtLatency(r.latency_ms)}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">
                      {r.filled_quantity > 0 ? (
                        <>
                          {r.filled_quantity}
                          {r.avg_fill_price != null && (
                            <span className="text-muted-foreground"> @ {r.avg_fill_price.toFixed(4)}</span>
                          )}
                        </>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground" title={r.reject_reason ?? undefined}>
                      {r.reject_reason ?? (r.broker_order_id ? `#${r.broker_order_id}` : "")}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
