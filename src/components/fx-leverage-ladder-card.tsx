import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { backtestFxPlaybook } from "@/lib/fx-playbook-backtest.functions";

const LEVERAGES = [1, 2, 3] as const;

function money(n: number, ccy: string, signed = true) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: ccy || "GBP",
    maximumFractionDigits: 0,
    signDisplay: signed ? "exceptZero" : "auto",
  }).format(n);
}

/**
 * Runs the FX funding-leg playbook at 1x, 2x and 3x the portfolio's real cash
 * so the extra profit from leverage can be read directly against the extra
 * drawdown and tail loss it buys. Same rules, same tape, only the notional
 * multiplier changes.
 */
export function FxLeverageLadderCard({
  portfolioId,
  pairs,
}: {
  portfolioId: string;
  pairs?: string[];
}) {
  const run = useServerFn(backtestFxPlaybook);
  const runPairs = pairs && pairs.length > 0 ? pairs : ["GBPUSD", "GBPEUR", "EURUSD"];

  const mutation = useMutation({
    mutationFn: async () => {
      const runs = await Promise.all(
        LEVERAGES.map((leverage) =>
          run({
            data: {
              pairs: runPairs,
              years: 10,
              side: "short" as const,
              costBps: 6,
              maxHoldDays: 30,
              leverage,
              portfolioId,
            },
          }),
        ),
      );
      return runs.map((r, i) => {
        const lev = LEVERAGES[i]!;
        const totalPnl = r.results.reduce((s, x) => s + x.money.totalPnl, 0);
        const maxDrawdown = r.results.reduce((s, x) => s + x.money.maxDrawdown, 0);
        const cvar5 = r.results.reduce((s, x) => s + x.money.cvar5Pnl, 0);
        const worstLeg = r.results.reduce(
          (m, x) => Math.min(m, x.money.worstLegPnl),
          0,
        );
        return {
          leverage: lev,
          capital: r.capital,
          currency: r.currency,
          capitalSource: r.capitalSource,
          totalPnl,
          maxDrawdown,
          cvar5,
          worstLeg,
        };
      });
    },
  });

  const rows = mutation.data ?? [];
  const ccy = rows[0]?.currency ?? "GBP";
  const capital = rows[0]?.capital ?? 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Leverage ladder — 1x / 2x / 3x cash</CardTitle>
          <div className="flex items-center gap-2">
            {capital > 0 && (
              <Badge variant="outline" className="text-[10px]">
                {money(capital, ccy, false)} cash
              </Badge>
            )}
            <Button
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "Running…" : "Run ladder"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {mutation.isError && (
          <p className="text-xs text-destructive">
            {(mutation.error as Error).message || "Ladder failed"}
          </p>
        )}
        {rows.length === 0 && !mutation.isPending && (
          <p className="text-xs text-muted-foreground">
            Replays 10 years of ECB closes with the live playbook rules (−1.5% cut, +2.0% take,
            30-day max hold) at three notional multiples of your real cash.
          </p>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-1 pr-3">Size</th>
                  <th className="py-1 pr-3 text-right">Total P&amp;L</th>
                  <th className="py-1 pr-3 text-right">Max drawdown</th>
                  <th className="py-1 pr-3 text-right">Worst leg</th>
                  <th className="py-1 text-right">CVaR 5%</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.leverage} className="border-t border-border/60">
                    <td className="py-1.5 pr-3 font-medium">{r.leverage}x cash</td>
                    <td
                      className={`py-1.5 pr-3 text-right tabular-nums ${
                        r.totalPnl < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"
                      }`}
                    >
                      {money(r.totalPnl, r.currency)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-destructive">
                      {money(-Math.abs(r.maxDrawdown), r.currency)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-destructive">
                      {money(-Math.abs(r.worstLeg), r.currency)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-destructive">
                      {money(-Math.abs(r.cvar5), r.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] leading-snug text-muted-foreground">
          Leverage scales profit and loss together: a 3x row that triples the P&amp;L also triples
          the drawdown and the tail. Sized on {capital > 0 ? "your live cash balance" : "portfolio cash"},
          split evenly across the {runPairs.length} pair{runPairs.length === 1 ? "" : "s"} in the run
          so the totals never assume more cash than you have; costs are 6bps per round trip.
        </p>
      </CardContent>
    </Card>
  );
}
