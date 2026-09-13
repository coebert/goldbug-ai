import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Badge } from "@/components/ui/badge";
import { getOrderFills } from "@/lib/order-fills.functions";
import { POLL } from "@/lib/query-keys";

function ukTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/London" });
}

function money(n: number, ccy: string) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: ccy || "GBP",
    maximumFractionDigits: 2,
  }).format(n);
}

function duration(ms: number | null) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

const STATUS_CLS: Record<string, string> = {
  filled: "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  partial: "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  submitted: "border-sky-500/50 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  rejected: "border-destructive/50 bg-destructive/10 text-destructive",
  error: "border-destructive/50 bg-destructive/10 text-destructive",
};

/**
 * Order status built from the broker's own fills: each row is a real order with
 * the quantity that actually executed, the fees the broker charged (invoiced
 * where available, modelled otherwise) and how long it took to execute.
 */
export function OrderFillsCard({ portfolioId }: { portfolioId: string }) {
  const fn = useServerFn(getOrderFills);
  const q = useQuery({
    queryKey: ["order-fills", portfolioId],
    queryFn: () => fn({ data: { portfolioId, limit: 40 } }),
    refetchInterval: POLL.LIVE,
  });

  const rows = q.data?.rows ?? [];

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-muted-foreground text-xs">Orders &amp; fills ({rows.length})</div>
        {q.data && (
          <Badge variant="outline" className="text-[10px]">
            {Math.round((q.data.feeCoverage ?? 0) * 100)}% broker-invoiced fees
          </Badge>
        )}
      </div>
      {q.isLoading && <p className="text-xs text-muted-foreground">Loading fills…</p>}
      {q.isError && (
        <p className="text-xs text-destructive">
          {(q.error as Error).message || "Could not load order fills"}
        </p>
      )}
      {!q.isLoading && rows.length === 0 && (
        <p className="text-xs italic text-muted-foreground">No broker orders yet.</p>
      )}
      {rows.length > 0 && (
        <div className="max-h-80 max-w-full overflow-auto">
          <table className="min-w-[46rem] w-full text-xs">
            <thead className="sticky top-0 bg-background">
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1 pr-2">Order</th>
                <th className="py-1 pr-2">Status</th>
                <th className="py-1 pr-2 text-right">Filled</th>
                <th className="py-1 pr-2 text-right">Avg price</th>
                <th className="py-1 pr-2 text-right">Fees</th>
                <th className="py-1 pr-2 text-right">Exec time</th>
                <th className="py-1">Executed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.orderId} className="border-t border-border/60 align-top">
                  <td className="py-1.5 pr-2">
                    <div className="font-medium">
                      {r.side.toUpperCase()} {r.symbol}
                    </div>
                    {r.brokerOrderId && (
                      <div className="font-mono text-[10px] text-muted-foreground">
                        #{r.brokerOrderId}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${STATUS_CLS[r.status] ?? "text-muted-foreground"}`}
                    >
                      {r.status}
                    </Badge>
                    {r.rejectReason && (
                      <div className="mt-0.5 max-w-[16rem] text-[10px] text-destructive">
                        {r.rejectReason}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {r.filledQty} / {r.orderedQty}
                    {r.fillCount > 1 && (
                      <div className="text-[10px] text-muted-foreground">{r.fillCount} fills</div>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {r.avgFillPrice == null ? "—" : r.avgFillPrice.toFixed(4)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {r.fillCount === 0 ? (
                      "—"
                    ) : (
                      <>
                        {money(r.fee, r.currency)}
                        <div className="text-[10px] text-muted-foreground">
                          {r.feeBps != null ? `${r.feeBps.toFixed(1)}bps · ` : ""}
                          {r.feeSource}
                        </div>
                      </>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{duration(r.executionMs)}</td>
                  <td className="py-1.5 text-[10px] text-muted-foreground">
                    {ukTime(r.lastFillAt ?? r.submittedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
