import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  backfillBrokerHistory,
  defaultBackfillWindow,
  type BrokerHistoryBackfillResult,
} from "@/lib/broker-history-backfill.functions";

/**
 * Pulls the broker's own historical daily bars into the price cache so the
 * backtest replays on the same tape the account actually traded against.
 */
export function BrokerHistoryBackfillCard({
  portfolioId,
  startedAt,
}: {
  portfolioId: string;
  startedAt?: string | null;
}) {
  const win = defaultBackfillWindow(startedAt);
  const [from, setFrom] = useState(win.from);
  const [to, setTo] = useState(win.to);
  const [result, setResult] = useState<BrokerHistoryBackfillResult | null>(null);
  const run = useServerFn(backfillBrokerHistory);

  const backfill = useMutation({
    mutationFn: () => run({ data: { portfolioId, from, to } }),
    onSuccess: (r) => {
      setResult(r);
      toast.success(`Cached ${r.barsWritten} broker bars for ${r.covered}/${r.requested} symbols`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Historical broker prices</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Loads Saxo's own daily closes for every symbol this portfolio holds or has traded, so the
          strategy-versus-reality comparison runs on real prints instead of a third-party estimate.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="bf-from">From</Label>
            <Input id="bf-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bf-to">To</Label>
            <Input id="bf-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button onClick={() => backfill.mutate()} disabled={backfill.isPending}>
            {backfill.isPending ? "Loading prices…" : "Backfill from broker"}
          </Button>
        </div>

        {result && (
          <div className="space-y-2">
            <p className="text-sm">
              <span className="tabular-nums font-medium">{result.barsWritten}</span> rows cached ·{" "}
              <span className="tabular-nums">{result.covered}</span>/
              <span className="tabular-nums">{result.requested}</span> symbols priced by the broker
              between {result.from} and {result.to}.
            </p>
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
              {result.symbols.map((s) => (
                <li key={s.symbol} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="font-medium">{s.symbol}</span>
                  <Badge
                    variant={s.source === "broker" ? "secondary" : "outline"}
                    className="text-[11px]"
                  >
                    {s.source === "broker" ? "Saxo bars" : "unavailable"}
                  </Badge>
                  <span className="tabular-nums text-muted-foreground">
                    {s.bars} bars{s.firstDate ? ` · ${s.firstDate} → ${s.lastDate}` : ""}
                  </span>
                  {s.reason && (
                    <span className="text-xs text-muted-foreground">{s.reason}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
