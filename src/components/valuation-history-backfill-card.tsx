import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { History, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { runValuationHistoryBackfill } from "@/lib/valuation/historical-backfill.functions";
import { qk } from "@/lib/query-keys";

type RunResult = Awaited<ReturnType<typeof runValuationHistoryBackfill>>;

/**
 * One-off maintenance action: rebuild every stored equity snapshot through the
 * valuation kernel, so historical days use the same units, FX and provenance
 * rules as today's number.
 */
export function ValuationHistoryBackfillCard({ className }: { className?: string }) {
  const queryClient = useQueryClient();
  const run = useServerFn(runValuationHistoryBackfill);
  const [last, setLast] = useState<RunResult | null>(null);

  const mutation = useMutation({
    mutationFn: (dryRun: boolean) => run({ data: { dryRun } }),
    onSuccess: (res: RunResult) => {
      setLast(res);
      const t = res.totals;
      toast.success(
        res.dryRun
          ? `Preview: ${t.daysScanned} day${t.daysScanned === 1 ? "" : "s"} checked, ${t.daysScanned - t.unchanged} would change`
          : `Revalued ${t.written} of ${t.daysScanned} day${t.daysScanned === 1 ? "" : "s"} · ${t.unchanged} already correct${t.rejected ? ` · ${t.rejected} rejected` : ""}`,
        { duration: 10000 },
      );
      if (!res.dryRun) {
        queryClient.invalidateQueries({ queryKey: ["equity-snapshots"] });
        queryClient.invalidateQueries({ queryKey: qk.portfolio.all() });
      }
    },
    onError: (e: unknown) =>
      toast.error(`Backfill failed: ${e instanceof Error ? e.message : String(e)}`),
  });

  const busy = mutation.isPending;

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4 text-primary" aria-hidden />
          Revalue snapshot history
        </CardTitle>
        <CardDescription>
          Rebuilds every historical daily equity value through the valuation
          kernel — same price units, FX and checks as today&apos;s figure. Safe
          to run more than once; days that already match are left alone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => mutation.mutate(true)}
          >
            {busy && mutation.variables === true ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            ) : null}
            Preview changes
          </Button>
          <Button size="sm" disabled={busy} onClick={() => mutation.mutate(false)}>
            {busy && mutation.variables === false ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <ShieldCheck className="mr-2 h-4 w-4" aria-hidden />
            )}
            Run backfill
          </Button>
        </div>

        {last ? (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {last.portfolios.map((p) => (
              <li key={p.portfolioId} className="flex flex-wrap justify-between gap-2">
                <span className="font-medium text-foreground">{p.portfolioName}</span>
                <span>
                  {p.daysScanned} day{p.daysScanned === 1 ? "" : "s"} · {p.written} rewritten ·{" "}
                  {p.unchanged} unchanged
                  {p.rejected ? ` · ${p.rejected} rejected` : ""}
                  {p.worstRatio && p.worstRatio > 3
                    ? ` · worst overstatement ${p.worstRatio.toFixed(0)}x`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
