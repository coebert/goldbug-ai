import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { History, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  backtestReclaimSetups,
  type SetupBacktestResult,
} from "@/lib/backtest/setup-scan-backtest.functions";

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

/** Selectable history depths, in calendar days. */
const LOOKBACKS = [
  { label: "2y", days: 730 },
  { label: "3y", days: 1095 },
  { label: "5y", days: 1825 },
] as const;

function PolicyTable({
  title,
  subtitle,
  stats,
}: {
  title: string;
  subtitle: string;
  stats: SetupBacktestResult["chase"];
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="mb-2">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 text-left font-normal">Horizon</th>
              <th className="py-1 text-right font-normal">n</th>
              <th className="py-1 text-right font-normal">Win rate</th>
              <th className="py-1 text-right font-normal">Avg net</th>
              <th className="py-1 text-right font-normal">Median</th>
              <th className="py-1 text-right font-normal">Expectancy</th>
            </tr>
          </thead>
          <tbody>
            {stats.horizons.map((h) => (
              <tr key={h.horizon} className="border-t">
                <td className="py-1">{h.horizon}d</td>
                <td className="py-1 text-right tabular-nums">{h.samples}</td>
                <td className="py-1 text-right tabular-nums">{h.winRatePct.toFixed(0)}%</td>
                <td
                  className={`py-1 text-right tabular-nums ${h.avgNetPct >= 0 ? "text-primary" : "text-destructive"}`}
                >
                  {pct(h.avgNetPct)}
                </td>
                <td className="py-1 text-right tabular-nums">{pct(h.medianNetPct)}</td>
                <td
                  className={`py-1 text-right tabular-nums ${h.expectancyPct >= 0 ? "text-primary" : "text-destructive"}`}
                >
                  {pct(h.expectancyPct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {stats.entries} entries{stats.skipped > 0 ? `, ${stats.skipped} signals skipped` : ""} ·
        avg worst drawdown {stats.avgMaxAdversePct == null ? "—" : `${stats.avgMaxAdversePct.toFixed(1)}%`} ·
        invalidated {stats.stopRatePct.toFixed(0)}% of the time
      </p>
    </div>
  );
}

/**
 * Replays the CRWV-derived post-reclaim rules over years of history to show how
 * often the pattern produced a profitable entry versus froth — and whether
 * waiting for the pullback beats chasing the surge bar.
 */
export function SetupBacktestCard() {
  const run = useServerFn(backtestReclaimSetups);
  const [result, setResult] = useState<SetupBacktestResult | null>(null);
  const [lookbackDays, setLookbackDays] = useState<number>(1095);

  const backtest = useMutation({
    mutationFn: () => run({ data: { limit: 24, lookbackDays } }),
    onSuccess: (r) => {
      setResult(r);
      if (r.signals === 0) toast.info("No historical signals found in the sampled tickers.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4 text-primary" />
          Pattern backtest: profitable or froth?
        </CardTitle>
        <div className="flex items-center gap-1">
          {LOOKBACKS.map((l) => (
            <Button
              key={l.days}
              size="sm"
              variant={l.days === lookbackDays ? "secondary" : "ghost"}
              className="h-7 px-2 text-xs"
              aria-pressed={l.days === lookbackDays}
              onClick={() => setLookbackDays(l.days)}
              disabled={backtest.isPending}
            >
              {l.label}
            </Button>
          ))}
          <Button size="sm" onClick={() => backtest.mutate()} disabled={backtest.isPending}>
          {backtest.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            {backtest.isPending ? "Replaying…" : "Run backtest"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Replays the same reclaim rules the scanner uses across historical tickers and measures what
          happened next, net of round-trip trading costs.
        </p>

        {result == null ? (
          <p className="text-sm text-muted-foreground">
            Run the backtest to see the historical hit rate of this setup.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{result.signals} signals</Badge>
              <Badge variant="secondary">{result.symbolsTested} tickers</Badge>
              <Badge variant="secondary">{(result.lookbackDays / 365).toFixed(1)}y history</Badge>
              <Badge variant="outline">{result.config.frictionBps}bps friction</Badge>
            </div>

            <p className="rounded-md bg-muted/50 p-3 text-sm">{result.verdict}</p>

            <div className="grid gap-3 md:grid-cols-2">
              <PolicyTable
                title="Chase the surge bar"
                subtitle="Buy the signal close, no wait."
                stats={result.chase}
              />
              <PolicyTable
                title="Wait for the pullback"
                subtitle="Buy only if it retests the reclaimed averages and holds."
                stats={result.discipline}
              />
            </div>

            {result.sampleTrades.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-1 text-left font-normal">Signal</th>
                      <th className="py-1 text-left font-normal">Symbol</th>
                      <th className="py-1 text-right font-normal">Entry</th>
                      <th className="py-1 text-right font-normal">10d net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.sampleTrades.slice(0, 10).map((t) => {
                      const r = t.netReturnPct[10];
                      return (
                        <tr key={`${t.symbol}-${t.signalDate}`} className="border-t">
                          <td className="py-1">{t.signalDate}</td>
                          <td className="py-1">{t.symbol}</td>
                          <td className="py-1 text-right tabular-nums">
                            {t.entryPrice == null ? "no entry" : t.entryPrice.toFixed(2)}
                          </td>
                          <td
                            className={`py-1 text-right tabular-nums ${
                              r == null ? "" : r >= 0 ? "text-primary" : "text-destructive"
                            }`}
                          >
                            {r == null ? "—" : pct(r)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}

            {result.errors.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Skipped: {result.errors.join("; ")}
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
