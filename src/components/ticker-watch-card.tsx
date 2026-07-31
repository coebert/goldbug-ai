import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Eye, Loader2, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  askTickerSecondOpinion,
  listTickerWatches,
  type SecondOpinion,
  type TickerWatchView,
} from "@/lib/ticker-watch.functions";

const TRIGGER_LABELS: Record<string, string> = {
  recovery_confirmed: "Recovery trigger hit",
  oversold_washout: "Oversold washout",
  invalidation: "Thesis invalidated",
  new_low: "New low",
};

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${tone ?? "text-foreground"}`}>{value}</div>
    </div>
  );
}

function WatchRow({ watch }: { watch: TickerWatchView }) {
  const askOpinion = useServerFn(askTickerSecondOpinion);
  const [opinion, setOpinion] = useState<SecondOpinion | null>(null);
  const opinionMutation = useMutation({
    mutationFn: () => askOpinion({ data: { symbol: watch.symbol } }),
    onSuccess: setOpinion,
  });

  const m = watch.metrics;
  const changeTone =
    m?.changePct1d == null
      ? undefined
      : m.changePct1d >= 0
        ? "text-emerald-500"
        : "text-destructive";

  return (
    <div className="space-y-3 rounded-xl border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold">{watch.symbol}</span>
            {watch.label ? (
              <span className="text-xs text-muted-foreground">{watch.label}</span>
            ) : null}
            <Badge variant={watch.active ? "default" : "secondary"} className="text-[10px]">
              {watch.active ? "Monitoring hourly" : "Paused"}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{watch.status}</p>
        </div>
        <div className="text-right">
          <div className="text-xl font-semibold tabular-nums">
            {m ? m.price.toFixed(2) : "—"}
          </div>
          <div className={`text-xs tabular-nums ${changeTone ?? "text-muted-foreground"}`}>
            {m?.changePct1d == null
              ? ""
              : `${m.changePct1d >= 0 ? "+" : ""}${m.changePct1d.toFixed(2)}% today`}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="20d avg" value={m?.sma20 ? m.sma20.toFixed(2) : "—"} />
        <Metric label="50d avg" value={m?.sma50 ? m.sma50.toFixed(2) : "—"} />
        <Metric label="RSI 14" value={m?.rsi14 == null ? "—" : m.rsi14.toFixed(0)} />
        <Metric
          label="Volatility"
          value={m?.annualVolPct == null ? "—" : `${m.annualVolPct.toFixed(0)}%`}
          tone={
            m?.annualVolPct != null && m.annualVolPct > watch.maxVolPct
              ? "text-amber-500"
              : undefined
          }
        />
      </div>

      <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
        {watch.buyAbove != null ? (
          <span className="rounded-full border border-border/60 px-2 py-0.5">
            Entry above {watch.buyAbove.toFixed(2)} with vol under {watch.maxVolPct}%
          </span>
        ) : null}
        <span className="rounded-full border border-border/60 px-2 py-0.5">
          Oversold under RSI {watch.oversoldRsi}
        </span>
        {watch.dropBelow != null ? (
          <span className="rounded-full border border-destructive/40 px-2 py-0.5 text-destructive">
            Invalidated below {watch.dropBelow.toFixed(2)}
          </span>
        ) : null}
      </div>

      {watch.firedToday.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {watch.firedToday.map((f) => (
            <Badge key={f.code} variant="outline" className="text-[10px]">
              {TRIGGER_LABELS[f.code] ?? f.code}
              {f.price != null ? ` @ ${f.price.toFixed(2)}` : ""}
            </Badge>
          ))}
        </div>
      ) : null}

      {watch.thesis ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{watch.thesis}</p>
      ) : null}

      <div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => opinionMutation.mutate()}
          disabled={opinionMutation.isPending}
        >
          {opinionMutation.isPending ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : null}
          Ask the AI now
        </Button>
        {opinion ? (
          <p className="mt-2 whitespace-pre-line rounded-lg bg-muted/40 p-3 text-xs leading-relaxed">
            {opinion.verdict}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Ticker watchlist: symbols the AI monitors between trading runs, with the
 * exact entry / invalidation levels that will trigger an alert.
 */
export function TickerWatchCard() {
  const fetchWatches = useServerFn(listTickerWatches);
  const query = useQuery({
    queryKey: ["ticker-watches"],
    queryFn: () => fetchWatches(),
    staleTime: 60_000,
  });

  const watches = query.data?.watches ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Eye className="h-4 w-4 text-primary" />
          AI watchlist
        </CardTitle>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
          aria-label="Refresh watchlist"
        >
          <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading watchlist…</p>
        ) : watches.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No symbols on watch yet.
          </p>
        ) : (
          watches.map((w) => <WatchRow key={w.id} watch={w} />)
        )}
        <p className="text-[11px] text-muted-foreground">
          Checked every hour against fresh prices. Alerts fire once per condition per day, to
          your notifications and phone — they flag a level being reached, not a recommendation
          to trade.
        </p>
      </CardContent>
    </Card>
  );
}
