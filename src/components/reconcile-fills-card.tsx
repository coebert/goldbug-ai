import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ClipboardCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  reconcileFillsToTrades,
  type FillsTradesReconcileResult,
} from "@/lib/fills-trades-reconcile.functions";
import { toast } from "sonner";

/**
 * Prominent one-click "rebuild my ledger from real broker fills" action.
 *
 * This used to be a small outline button tucked into the Order-reconciliation
 * card header on the admin page, which was effectively impossible to find. It
 * now lives on the portfolio itself, labelled in plain English.
 */
export function ReconcileFillsCard({
  portfolioId,
  className,
}: {
  portfolioId: string;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const runFillsToTrades = useServerFn(reconcileFillsToTrades);

  const mutation = useMutation({
    mutationFn: () => runFillsToTrades({ data: { portfolioId } }),
    onSuccess: (res: FillsTradesReconcileResult) => {
      const h = res.holdings;
      const brokerPart = h.skipped
        ? `holdings sync skipped (${h.reason ?? "unknown"})`
        : `${h.brokerPositions ?? 0} broker position${h.brokerPositions === 1 ? "" : "s"} · ${(h.newTotalValue ?? 0).toFixed(2)} ${h.currency ?? ""}`;
      toast.success(
        `Rebuilt from fills: ${res.tradesFromFillsInserted} trade row${res.tradesFromFillsInserted === 1 ? "" : "s"} from ${res.fillsSeen} fill${res.fillsSeen === 1 ? "" : "s"} · dropped ${res.optimisticTradesDropped} unconfirmed · ${brokerPart}`,
        { duration: 10000 },
      );
      queryClient.invalidateQueries({ queryKey: ["order-recon-view"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["trades"] });
      queryClient.invalidateQueries({ queryKey: ["holdings"] });
    },
    onError: (e: unknown) =>
      toast.error(`Rebuild failed: ${e instanceof Error ? e.message : String(e)}`),
  });

  return (
    <Card className={`border-primary/40 bg-primary/5 ${className ?? ""}`}>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <ClipboardCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">
              Trades or holdings look wrong?
            </p>
            <p className="text-xs text-muted-foreground">
              Rebuilds this portfolio's buy/sell history from the real broker fills, drops
              anything that was never actually executed, and refreshes holdings and cash.
              Safe to run any time.
            </p>
          </div>
        </div>
        <Button
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          className="w-full shrink-0 sm:w-auto"
          data-testid="reconcile-fills-button"
        >
          {mutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <ClipboardCheck className="mr-2 h-4 w-4" />
          )}
          {mutation.isPending ? "Rebuilding…" : "Reconcile fills → trades"}
        </Button>
      </CardContent>
    </Card>
  );
}
