import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Play, Crosshair } from "lucide-react";
import {
  runBreakoutExitParameterSweep,
  type BreakoutExitSweepResponse,
} from "@/lib/breakout-exit-sweep.functions";
import type { ExitSweepResult } from "@/lib/breakout-exit-sweep";

const tone = (v: number) => (v >= 0 ? "text-emerald-500" : "text-red-500");
const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

function Row({ r, tag }: { r: ExitSweepResult; tag?: string }) {
  return (
    <tr className="border-t border-border/60">
      <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums">
        {r.params.stopAtr} / {r.params.targetAtr} ATR
        {tag ? <span className="ml-1 text-[10px] text-muted-foreground">{tag}</span> : null}
      </td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{r.rewardRisk.toFixed(2)}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{r.confirmed.trades}</td>
      <td className="py-1.5 pr-3 text-right font-medium tabular-nums">
        {r.confirmed.winRatePct.toFixed(1)}%
      </td>
      <td className={`py-1.5 pr-3 text-right tabular-nums ${tone(r.confirmed.avgReturnPct)}`}>
        {pct(r.confirmed.avgReturnPct)}
      </td>
      <td className={`py-1.5 pr-3 text-right tabular-nums ${tone(r.confirmed.expectancyPct)}`}>
        {pct(r.confirmed.expectancyPct)}
      </td>
      <td className="py-1.5 pr-3 text-right tabular-nums text-red-500">
        {r.confirmed.maxDrawdownPct.toFixed(1)}%
      </td>
      <td className="py-1.5 text-right tabular-nums text-muted-foreground">
        {r.confirmed.avgBarsHeld.toFixed(1)}b
      </td>
    </tr>
  );
}

function Tile({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: string;
  sub: string;
  className?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${className ?? ""}`}>{value}</p>
      <p className="text-[11px] text-muted-foreground">{sub}</p>
    </div>
  );
}

export function BreakoutExitSweepCard({ portfolioId }: { portfolioId: string }) {
  const sweepFn = useServerFn(runBreakoutExitParameterSweep);
  const [result, setResult] = useState<BreakoutExitSweepResponse | null>(null);
  const [horizon, setHorizon] = useState(10);

  const run = useMutation({
    mutationFn: () => sweepFn({ data: { portfolioId, horizonBars: [horizon] } }),
    onSuccess: (r) => setResult(r),
  });

  const combo = (r: ExitSweepResult) => `${r.params.stopAtr} / ${r.params.targetAtr} ATR`;

  return (
    <Card data-testid="breakout-exit-sweep-card">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Crosshair className="h-4 w-4" /> Breakout stop / target sweep
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Replays every confirmed breakout under stops of 1–3 ATR against targets of 2–5 ATR
              and shows which combination lifts the win rate and shrinks the drawdown. A near
              target flatters the hit rate by capping winners, so expectancy is shown alongside.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={horizon}
              onChange={(e) => setHorizon(Number(e.target.value))}
              aria-label="Holding horizon"
            >
              <option value={5}>5-bar hold</option>
              <option value={10}>10-bar hold</option>
              <option value={20}>20-bar hold</option>
            </select>
            <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
              <Play className="mr-1 h-3 w-3" />
              {run.isPending ? "Sweeping…" : "Run sweep"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {run.isError && <p className="text-xs text-destructive">{(run.error as Error).message}</p>}
        {run.isPending && (
          <p className="text-xs text-muted-foreground">
            Replaying 25 stop/target combinations across the tape — this takes a minute.
          </p>
        )}
        {!result && !run.isPending && (
          <p className="text-xs text-muted-foreground">
            No sweep yet — run it to compare exit settings on real history.
          </p>
        )}

        {result && (
          <>
            <p className="text-xs text-muted-foreground">
              {result.gridSize} combinations · {result.symbols.length} symbols ·{" "}
              {result.from ?? "?"} → {result.to ?? "?"} · {result.costBps}bps costs
            </p>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile
                label="Live setting"
                value={`${result.baseline.confirmed.winRatePct.toFixed(1)}%`}
                sub={`${combo(result.baseline)} · dd ${result.baseline.confirmed.maxDrawdownPct.toFixed(0)}%`}
              />
              <Tile
                label="Best win rate"
                value={
                  result.bestWinRate ? `${result.bestWinRate.confirmed.winRatePct.toFixed(1)}%` : "—"
                }
                sub={result.bestWinRate ? combo(result.bestWinRate) : "no scoreable sample"}
              />
              <Tile
                label="Shallowest drawdown"
                value={
                  result.bestDrawdown
                    ? `${result.bestDrawdown.confirmed.maxDrawdownPct.toFixed(1)}%`
                    : "—"
                }
                sub={result.bestDrawdown ? combo(result.bestDrawdown) : "no scoreable sample"}
                className="text-red-500"
              />
              <Tile
                label="Best expectancy"
                value={
                  result.bestExpectancy ? pct(result.bestExpectancy.confirmed.expectancyPct) : "—"
                }
                sub={result.bestExpectancy ? combo(result.bestExpectancy) : "no scoreable sample"}
                className={
                  result.bestExpectancy ? tone(result.bestExpectancy.confirmed.expectancyPct) : ""
                }
              />
            </div>

            <ul className="space-y-1 text-xs text-muted-foreground">
              {result.notes.map((n) => (
                <li key={n}>• {n}</li>
              ))}
            </ul>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-xs">
                <thead className="text-[11px] text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 text-left font-normal">Stop / target</th>
                    <th className="py-1 pr-3 text-right font-normal">R:R</th>
                    <th className="py-1 pr-3 text-right font-normal">Signals</th>
                    <th className="py-1 pr-3 text-right font-normal">Win rate</th>
                    <th className="py-1 pr-3 text-right font-normal">Avg return</th>
                    <th className="py-1 pr-3 text-right font-normal">Expectancy</th>
                    <th className="py-1 pr-3 text-right font-normal">Max DD</th>
                    <th className="py-1 text-right font-normal">Held</th>
                  </tr>
                </thead>
                <tbody>
                  <Row r={result.baseline} tag="live" />
                  {result.topResults.map((r) => (
                    <Row key={`${r.params.stopAtr}-${r.params.targetAtr}`} r={r} />
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[11px] text-muted-foreground">
              Ranked on a blend of win rate, drawdown relief and expectancy. Exit tuning alone
              cannot create an edge — if expectancy stays negative everywhere, the signal, not the
              stop, is the problem.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
