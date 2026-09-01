import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { backtestFxPlaybook } from "@/lib/fx-playbook-backtest.functions";

const LEVERAGES = [1, 2, 3] as const;
const BUDGETS = [
  { label: "No stop", pct: 0 },
  { label: "10% stop", pct: 0.1 },
  { label: "20% stop", pct: 0.2 },
  { label: "30% stop", pct: 0.3 },
] as const;

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
 * drawdown and tail loss it buys.
 *
 * One pair per run, sized on the whole cash balance: splitting the same cash
 * across three pairs made every row a blend of three quarter-sized sleeves and
 * hid what the leverage multiple actually does. A drawdown budget can stop the
 * pair for good once its cash curve falls that far below its peak.
 */
export function FxLeverageLadderCard({
  portfolioId,
  pairs,
}: {
  portfolioId: string;
  pairs?: string[];
}) {
  const run = useServerFn(backtestFxPlaybook);
  const pair = (pairs && pairs.length > 0 ? pairs[0]! : "GBPUSD").toUpperCase();
  const [budgetPct, setBudgetPct] = useState<number>(0.2);

  const mutation = useMutation({
    mutationFn: async () => {
      const runs = await Promise.all(
        LEVERAGES.map((leverage) =>
          run({
            data: {
              // Single pair per run so the whole cash balance backs it and the
              // ladder shows true 1x / 2x / 3x exposure.
              pairs: [pair],
              years: 10,
              side: "short" as const,
              costBps: 6,
              maxHoldDays: 30,
              leverage,
              portfolioId,
              drawdownBudgetPct: budgetPct,
            },
          }),
        ),
      );
      return runs.map((r, i) => {
        const lev = LEVERAGES[i]!;
        const leg = r.results[0];
        const m = leg?.money;
        return {
          leverage: lev,
          capital: r.capital,
          currency: r.currency,
          totalPnl: m?.totalPnl ?? 0,
          maxDrawdown: m?.maxDrawdown ?? 0,
          cvar5: m?.cvar5Pnl ?? 0,
          worstLeg: m?.worstLegPnl ?? 0,
          stoppedAt: m?.stoppedAt ?? null,
          legsSkipped: m?.legsSkipped ?? 0,
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
          <CardTitle className="text-base">
            Leverage ladder — {pair} at 1x / 2x / 3x cash
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {capital > 0 && (
              <Badge variant="outline" className="text-[10px]">
                {money(capital, ccy, false)} cash
              </Badge>
            )}
            <div className="flex gap-1">
              {BUDGETS.map((b) => (
                <Button
                  key={b.pct}
                  size="sm"
                  variant={budgetPct === b.pct ? "default" : "outline"}
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setBudgetPct(b.pct)}
                >
                  {b.label}
                </Button>
              ))}
            </div>
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
            Replays 10 years of ECB closes for {pair} with the live playbook rules (−1.5% cut,
            +2.0% take, 30-day max hold) at three notional multiples of your real cash.
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
                  <th className="py-1 pr-3 text-right">CVaR 5%</th>
                  <th className="py-1 text-right">Budget stop</th>
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
                    <td className="py-1.5 pr-3 text-right tabular-nums text-destructive">
                      {money(-Math.abs(r.cvar5), r.currency)}
                    </td>
                    <td className="py-1.5 text-right text-[11px] tabular-nums">
                      {r.stoppedAt ? (
                        <span className="text-amber-600 dark:text-amber-400">
                          closed {r.stoppedAt} ({r.legsSkipped} legs skipped)
                        </span>
                      ) : (
                        <span className="text-muted-foreground">never hit</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] leading-snug text-muted-foreground">
          Leverage scales profit and loss together: a 3x row that triples the P&amp;L also triples
          the drawdown and the tail. Each row runs {pair} alone on{" "}
          {capital > 0 ? "your full live cash balance" : "the portfolio's full cash balance"}, so
          the multiple is real exposure rather than a shared slice. With a budget selected the pair
          stops opening new legs for good once its cash curve falls that far below its peak; costs
          are 6bps per round trip.
        </p>
      </CardContent>
    </Card>
  );
}
