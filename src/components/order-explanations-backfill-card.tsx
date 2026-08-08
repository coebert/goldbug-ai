import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  backfillOrderExplanations,
  getOrderExplanationBackfillStatus,
} from "@/lib/order-explanations.functions";

export function OrderExplanationsBackfillCard({ portfolioId }: { portfolioId?: string }) {
  const statusFn = useServerFn(getOrderExplanationBackfillStatus);
  const backfillFn = useServerFn(backfillOrderExplanations);
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<{ explained: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["order-explanation-backfill", portfolioId ?? "all"],
    queryFn: () => statusFn({ data: portfolioId ? { portfolioId } : {} }),
    staleTime: 30_000,
  });

  const total = live?.total ?? q.data?.totalOrders ?? 0;
  const explained = live?.explained ?? q.data?.explained ?? 0;
  const missing = Math.max(0, total - explained);
  const pct = total > 0 ? Math.round((explained / total) * 100) : 100;

  async function run() {
    setRunning(true);
    setError(null);
    try {
      for (let i = 0; i < 200; i += 1) {
        const res = await backfillFn({
          data: { batchSize: 10, ...(portfolioId ? { portfolioId } : {}) },
        });
        setLive({ explained: res.explained, total: res.totalOrders });
        if (res.errors.length) setError(res.errors[0] ?? null);
        if (res.missing === 0 || res.generated === 0) break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backfill failed");
    } finally {
      setRunning(false);
      void q.refetch();
    }
  }

  /**
   * Re-check the server for orders that still have no stored explanation
   * (batches that failed, were rate-limited, or arrived after the last
   * backfill) and generate them.
   */
  async function rerunMissing() {
    setRunning(true);
    setError(null);
    try {
      const fresh = await q.refetch();
      setLive(
        fresh.data
          ? { explained: fresh.data.explained, total: fresh.data.totalOrders }
          : null,
      );
      if ((fresh.data?.missing ?? 0) === 0) {
        setError(null);
        return;
      }
      for (let i = 0; i < 200; i += 1) {
        const res = await backfillFn({
          data: { batchSize: 10, ...(portfolioId ? { portfolioId } : {}) },
        });
        setLive({ explained: res.explained, total: res.totalOrders });
        if (res.errors.length) setError(res.errors[0] ?? null);
        if (res.missing === 0 || res.generated === 0) break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setRunning(false);
      void q.refetch();
    }
  }


  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" /> Trade explanations
        </CardTitle>
        <CardDescription>
          Generate the plain-English &ldquo;why this trade&rdquo; summary and expected hold for
          every past order, so older decisions read the same as new ones.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Progress value={pct} className="h-2" />
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
          <span>
            {explained} of {total} past orders explained
          </span>
          <span>{missing === 0 ? "All caught up" : `${missing} remaining`}</span>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button size="sm" onClick={run} disabled={running || q.isLoading || missing === 0}>
          {running && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
          {running ? "Backfilling…" : missing === 0 ? "Nothing to backfill" : "Backfill explanations"}
        </Button>
      </CardContent>
    </Card>
  );
}
