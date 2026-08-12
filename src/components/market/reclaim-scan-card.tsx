import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Radar } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import {
  addSetupMatchesToWatchlist,
  scanReclaimSetups,
  type ReclaimScanResult,
} from "@/lib/setup-scan.functions";
import { SetupMatchChart } from "@/components/market/setup-match-chart";

/**
 * Applies the CRWV-derived rules across the market: high-volatility names that
 * have just reclaimed their 50d/200d averages on thin relative volume. Matches
 * are watch candidates, never buy signals.
 */
export function ReclaimScanCard() {
  const runScan = useServerFn(scanReclaimSetups);
  const addMatches = useServerFn(addSetupMatchesToWatchlist);
  const queryClient = useQueryClient();
  const [result, setResult] = useState<ReclaimScanResult | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const scan = useMutation({
    mutationFn: () => runScan(),
    onSuccess: (r) => {
      setResult(r);
      setSelected(r.matches.map((m) => m.symbol));
      if (r.matches.length === 0) toast.info(`No matching setups across ${r.scanned} symbols.`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const add = useMutation({
    mutationFn: () => addMatches({ data: { symbols: selected } }),
    onSuccess: (r) => {
      toast.success(
        r.added.length > 0
          ? `Added ${r.added.join(", ")} to the watchlist.`
          : "Nothing added — the setups no longer qualify.",
      );
      void queryClient.invalidateQueries({ queryKey: ["ticker-watches"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = (symbol: string) =>
    setSelected((prev) =>
      prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol],
    );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Radar className="h-4 w-4 text-primary" />
          Post-reclaim setup scan
        </CardTitle>
        <Button size="sm" onClick={() => scan.mutate()} disabled={scan.isPending}>
          {scan.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
          Scan market
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Looks for the CoreWeave pattern: a high-volatility name that has surged back above its
          50-day and 200-day averages on less than 2x normal volume. Thin tape means the move is
          unconfirmed — these are monitored for a pullback, never chased.
        </p>

        {result ? (
          <>
            <div className="text-xs text-muted-foreground">
              Scanned {result.scanned} symbols · {result.matches.length} match
              {result.matches.length === 1 ? "" : "es"}
            </div>

            {result.matches.map((m) => (
              <div key={m.symbol} className="space-y-2 rounded-xl border border-border/60 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex items-start gap-2">
                    <Checkbox
                      checked={selected.includes(m.symbol)}
                      onCheckedChange={() => toggle(m.symbol)}
                      aria-label={`Select ${m.symbol}`}
                      className="mt-1"
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-base font-semibold">{m.symbol}</span>
                        {m.name ? (
                          <span className="text-xs text-muted-foreground">{m.name}</span>
                        ) : null}
                        <Badge variant="outline" className="text-[10px]">
                          Fit {m.score}/100
                        </Badge>
                      </div>
                      <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                        {m.reasons.map((r) => (
                          <li key={r}>· {r}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-semibold tabular-nums">{m.price.toFixed(2)}</div>
                    <div
                      className={`text-xs tabular-nums ${m.changePct1d >= 0 ? "text-emerald-500" : "text-destructive"}`}
                    >
                      {m.changePct1d >= 0 ? "+" : ""}
                      {m.changePct1d.toFixed(2)}% today
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                  <span className="rounded-full border border-border/60 px-2 py-0.5">
                    Pullback zone {m.zoneLow.toFixed(2)}–{m.zoneHigh.toFixed(2)}
                  </span>
                  <span className="rounded-full border border-border/60 px-2 py-0.5">
                    Max {m.maxWeightPct}% of NAV
                  </span>
                  <span className="rounded-full border border-destructive/40 px-2 py-0.5 text-destructive">
                    Invalidated below {m.invalidationBelow.toFixed(2)}
                  </span>
                </div>
                <SetupMatchChart match={m} />
              </div>
            ))}

            {result.matches.length > 0 ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => add.mutate()}
                disabled={add.isPending || selected.length === 0}
              >
                {add.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                Add {selected.length} to watchlist
              </Button>
            ) : null}

            {result.nearMisses.length > 0 ? (
              <details className="text-[11px] text-muted-foreground">
                <summary className="cursor-pointer">Why the others were skipped</summary>
                <ul className="mt-1 space-y-0.5">
                  {result.nearMisses.map((n) => (
                    <li key={n.symbol}>
                      <span className="font-medium">{n.symbol}</span> — {n.reason}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
