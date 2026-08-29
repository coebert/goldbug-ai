import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { backtestFxPlaybook } from "@/lib/fx-playbook-backtest.functions";

const PAIRS = ["GBPUSD", "GBPEUR", "EURUSD", "GBPJPY"];

function pct(n: number, digits = 2) {
  return `${n >= 0 ? "+" : "−"}${(Math.abs(n) * 100).toFixed(digits)}%`;
}

/**
 * Runs the FX funding-leg playbook (−1.5% cut, +2.0% take, 30-day max hold)
 * over a decade of ECB daily closes so the rules can be judged on realised
 * hit rate, compounded return and worst-case drawdown before live capital.
 */
export function FxPlaybookBacktestCard() {
  const [side, setSide] = useState<"short" | "long">("short");
  const [years, setYears] = useState(10);
  const run = useServerFn(backtestFxPlaybook);

  const mutation = useMutation({
    mutationFn: () => run({ data: { pairs: PAIRS, years, side, costBps: 6, maxHoldDays: 30 } }),
  });

  const results = mutation.data?.results ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">FX playbook backtest</CardTitle>
          <div className="flex flex-wrap items-center gap-1">
            {(["short", "long"] as const).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={side === s ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs"
                onClick={() => setSide(s)}
              >
                {s === "short" ? "Short base" : "Long base"}
              </Button>
            ))}
            {[5, 10, 20].map((y) => (
              <Button
                key={y}
                size="sm"
                variant={years === y ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs"
                onClick={() => setYears(y)}
              >
                {y}y
              </Button>
            ))}
            <Button
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "Running…" : "Run"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Replays the live rules — cut at −1.5%, take at +2.0%, force-close after 30 days, 6bps
          round-trip cost — on daily ECB closes. Drawdown is the worst peak-to-trough of
          compounding one leg at a time.
        </p>

        {mutation.isError && (
          <p className="text-sm text-destructive">
            {(mutation.error as Error)?.message ?? "Backtest failed"}
          </p>
        )}

        {results.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="py-1 pr-2">Pair</th>
                  <th className="py-1 pr-2 text-right">Legs</th>
                  <th className="py-1 pr-2 text-right">Win rate</th>
                  <th className="py-1 pr-2 text-right">Avg leg</th>
                  <th className="py-1 pr-2 text-right">Total</th>
                  <th className="py-1 pr-2 text-right">Max DD</th>
                  <th className="py-1 pr-2 text-right">CVaR5</th>
                  <th className="py-1 pr-2 text-right">TP/SL/hold</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.pair} className="border-t">
                    <td className="py-1 pr-2 font-medium">
                      {r.pair}
                      {r.error && (
                        <Badge variant="outline" className="ml-1 text-[10px]">
                          {r.error}
                        </Badge>
                      )}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">{r.tradeCount}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      {(r.winRate * 100).toFixed(0)}%
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">{pct(r.avgPnlPct)}</td>
                    <td
                      className={`py-1 pr-2 text-right tabular-nums ${
                        r.totalReturnPct >= 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-destructive"
                      }`}
                    >
                      {pct(r.totalReturnPct, 1)}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums text-destructive">
                      −{(r.maxDrawdownPct * 100).toFixed(1)}%
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">{pct(r.cvar5Pct)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      {r.hitTakeProfit}/{r.hitStopLoss}/{r.timedOut}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {results.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {results[0]?.from ? `Tape ${results[0].from} → ${results[0].to}. ` : ""}
            A negative total with a high win rate means the −1.5% cut fires more than the +2.0%
            take pays — treat FX legs as funding, not as an alpha source.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
