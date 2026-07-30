import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { History, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  advanceNewsBackfillRun,
  cancelNewsBackfillRun,
  getNewsBackfillStatus,
  startNewsBackfillRun,
} from "@/lib/news-backfill.functions";
import { backfillProgress, describeBackfillStatus } from "@/lib/news-backfill";

/**
 * Compact control strip for the historical backfill: pick a 30/60/90-day
 * lookback, kick it off, and watch it catch the reel up with the feeds that
 * were added after the catalogue was expanded.
 */
export function NewsBackfillControls() {
  const status = useServerFn(getNewsBackfillStatus);
  const start = useServerFn(startNewsBackfillRun);
  const advance = useServerFn(advanceNewsBackfillRun);
  const cancel = useServerFn(cancelNewsBackfillRun);

  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);

  const q = useQuery({
    queryKey: ["news-backfill-status"],
    queryFn: () => status(),
    refetchInterval: 30_000,
  });

  const job = q.data?.job ?? null;
  const newFeeds = q.data?.new_feeds ?? 0;
  const running = job?.status === "running";
  const pct = job ? backfillProgress(job).pct : 0;

  const run = async (fn: () => Promise<{ inserted: number; done: boolean; reason?: string }>) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fn();
      toast.success(
        `${res.inserted} historical headline${res.inserted === 1 ? "" : "s"} added. ${res.reason ?? ""}`.trim(),
      );
    } catch (err) {
      toast.error(`Backfill failed: ${String(err)}`);
    } finally {
      setBusy(false);
      await q.refetch();
    }
  };

  return (
    <div className="rounded-lg border border-border bg-background/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <History className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="text-xs font-medium text-foreground">Historical backfill</span>
        <span className="text-[11px] text-muted-foreground">
          {newFeeds > 0
            ? `${newFeeds} newly added feed${newFeeds === 1 ? "" : "s"} with no history yet`
            : "All catalogue feeds already have history"}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <label className="sr-only" htmlFor="backfill-days">
            Backfill lookback in days
          </label>
          <select
            id="backfill-days"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            disabled={running || busy}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
          >
            <option value={30}>Last 30 days</option>
            <option value={60}>Last 60 days</option>
            <option value={90}>Last 90 days</option>
          </select>

          {running ? (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 px-2 text-xs"
                disabled={busy}
                onClick={() => run(() => advance())}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <History className="h-3.5 w-3.5" />}
                Continue
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2 text-xs"
                disabled={busy}
                onClick={async () => {
                  await cancel();
                  await q.refetch();
                  toast.info("Backfill cancelled.");
                }}
              >
                <X className="h-3.5 w-3.5" />
                Stop
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 px-2 text-xs"
              disabled={busy}
              onClick={() => run(() => start({ data: { days } }))}
              title="Re-ingest recent history from feeds added since the catalogue was expanded"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <History className="h-3.5 w-3.5" />}
              {busy ? "Backfilling…" : "Backfill history"}
            </Button>
          )}
        </div>
      </div>

      {job ? (
        <div className="mt-2 space-y-1.5">
          <Progress value={pct} className="h-1.5" />
          <p className="text-[11px] leading-tight text-muted-foreground">{describeBackfillStatus(job)}</p>
        </div>
      ) : (
        <p className="mt-2 text-[11px] leading-tight text-muted-foreground">
          Pulls 30–90 days of stories from the newly added publishers so the reel reflects the expanded source
          catalogue straight away. History is timestamped on its own day, so today&rsquo;s headlines stay on top.
        </p>
      )}
    </div>
  );
}
