import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Play, SlidersHorizontal, ShieldCheck, ShieldAlert, TriangleAlert } from "lucide-react";
import {
  runBreakoutParameterSweep,
  type BreakoutSweepResponse,
} from "@/lib/breakout-param-sweep.functions";
import type { SweepCandidateResult } from "@/lib/breakout-param-sweep";

const tone = (v: number) => (v >= 0 ? "text-emerald-500" : "text-red-500");
const pp = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

function VerdictBadge({ verdict }: { verdict: BreakoutSweepResponse["verdict"] }) {
  if (verdict === "found_positive_edge") {
    return (
      <Badge className="gap-1 border-emerald-500/30 bg-emerald-500/15 text-emerald-500">
        <ShieldCheck className="h-3 w-3" /> Settings survived holdout
      </Badge>
    );
  }
  if (verdict === "train_only") {
    return (
      <Badge className="gap-1 border-amber-500/30 bg-amber-500/15 text-amber-500">
        <TriangleAlert className="h-3 w-3" /> In-sample only (overfit)
      </Badge>
    );
  }
  return (
    <Badge className="gap-1 border-red-500/30 bg-red-500/15 text-red-500">
      <ShieldAlert className="h-3 w-3" /> No positive edge found
    </Badge>
  );
}

function StatusBadge({ status }: { status: SweepCandidateResult["status"] }) {
  const map: Record<SweepCandidateResult["status"], string> = {
    accepted: "text-emerald-500",
    overfit: "text-amber-500",
    rejected: "text-red-500",
    thin: "text-muted-foreground",
  };
  return <span className={`text-[11px] ${map[status]}`}>{status}</span>;
}

function Row({ r }: { r: SweepCandidateResult }) {
  return (
    <tr className="border-t border-border/60">
      <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums">{r.params.channelBars}</td>
      <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums">
        {r.params.minBaseBars}b / {(r.params.maxBasePct * 100).toFixed(0)}%
      </td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{r.params.minPenetrationAtr}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{r.params.minVolumeRatio}×</td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{r.train.confirmedTrades}</td>
      <td className={`py-1.5 pr-3 text-right tabular-nums ${tone(r.train.confirmedAvgReturnPct)}`}>
        {pp(r.train.confirmedAvgReturnPct)}
      </td>
      <td
        className={`py-1.5 pr-3 text-right tabular-nums ${
          r.holdout ? tone(r.holdout.confirmedAvgReturnPct) : "text-muted-foreground"
        }`}
      >
        {r.holdout ? pp(r.holdout.confirmedAvgReturnPct) : "—"}
      </td>
      <td className="py-1.5 pr-3 text-right tabular-nums text-red-500">
        {r.train.confirmedMaxDrawdownPct.toFixed(0)}%
      </td>
      <td className="py-1.5 text-right">
        <StatusBadge status={r.status} />
      </td>
    </tr>
  );
}

export function BreakoutParamSweepCard({ portfolioId }: { portfolioId: string }) {
  const sweepFn = useServerFn(runBreakoutParameterSweep);
  const [result, setResult] = useState<BreakoutSweepResponse | null>(null);
  const [maxCandidates, setMaxCandidates] = useState(120);

  const run = useMutation({
    mutationFn: () => sweepFn({ data: { portfolioId, maxCandidates } }),
    onSuccess: (r) => setResult(r),
  });

  return (
    <Card data-testid="breakout-param-sweep-card">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <SlidersHorizontal className="h-4 w-4" /> Breakout parameter sweep
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Automatically tries every combination of base length/width, ATR penetration and
              volume expansion, ranks them on the confirmed cohort's net return, and only calls a
              setting a winner if it also pays on a later holdout window it was never tuned on.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={maxCandidates}
              onChange={(e) => setMaxCandidates(Number(e.target.value))}
              aria-label="Combinations to test"
            >
              <option value={48}>48 combos (fast)</option>
              <option value={120}>120 combos</option>
              <option value={432}>Full grid (slow)</option>
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
            Replaying the detector across every candidate — this takes a minute.
          </p>
        )}
        {!result && !run.isPending && (
          <p className="text-xs text-muted-foreground">
            No sweep yet — run it to see whether any detector settings earn the confirmed-breakout
            size boost.
          </p>
        )}

        {result && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <VerdictBadge verdict={result.verdict} />
              <span className="text-xs text-muted-foreground">
                {result.evaluated} combinations · {result.symbols.length} symbols · train{" "}
                {result.trainRange?.from ?? "?"} → {result.trainRange?.to ?? "?"} · holdout{" "}
                {result.holdoutRange?.from ?? "—"} → {result.holdoutRange?.to ?? ""}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-border/60 p-3">
                <p className="text-[11px] text-muted-foreground">Baseline confirmed return</p>
                <p
                  className={`text-lg font-semibold tabular-nums ${tone(
                    result.baseline.train.confirmedAvgReturnPct,
                  )}`}
                >
                  {pp(result.baseline.train.confirmedAvgReturnPct)}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  shipped defaults · {result.baseline.train.confirmedTrades} signals
                </p>
              </div>
              <div className="rounded-lg border border-border/60 p-3">
                <p className="text-[11px] text-muted-foreground">Best candidate (train)</p>
                <p
                  className={`text-lg font-semibold tabular-nums ${
                    result.topResults[0] ? tone(result.topResults[0].train.confirmedAvgReturnPct) : ""
                  }`}
                >
                  {result.topResults[0]
                    ? pp(result.topResults[0].train.confirmedAvgReturnPct)
                    : "—"}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {result.totalRanked} of {result.evaluated} had a scoreable sample
                </p>
              </div>
              <div className="rounded-lg border border-border/60 p-3">
                <p className="text-[11px] text-muted-foreground">Holdout confirmed return</p>
                <p
                  className={`text-lg font-semibold tabular-nums ${
                    result.best ? tone(result.best.holdout!.confirmedAvgReturnPct) : "text-muted-foreground"
                  }`}
                >
                  {result.best ? pp(result.best.holdout!.confirmedAvgReturnPct) : "—"}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {result.best ? "survived out of sample" : "nothing survived"}
                </p>
              </div>
            </div>

            <ul className="space-y-1 text-xs text-muted-foreground">
              {result.notes.map((n) => (
                <li key={n}>• {n}</li>
              ))}
            </ul>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs">
                <thead className="text-[11px] text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 text-left font-normal">Channel</th>
                    <th className="py-1 pr-3 text-left font-normal">Base min/max</th>
                    <th className="py-1 pr-3 text-right font-normal">Penetration</th>
                    <th className="py-1 pr-3 text-right font-normal">Volume</th>
                    <th className="py-1 pr-3 text-right font-normal">Signals</th>
                    <th className="py-1 pr-3 text-right font-normal">Train avg</th>
                    <th className="py-1 pr-3 text-right font-normal">Holdout avg</th>
                    <th className="py-1 pr-3 text-right font-normal">Max DD</th>
                    <th className="py-1 text-right font-normal">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.topResults.map((r) => (
                    <Row
                      key={`${r.params.channelBars}-${r.params.minBaseBars}-${r.params.maxBasePct}-${r.params.minPenetrationAtr}-${r.params.minVolumeRatio}`}
                      r={r}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[11px] text-muted-foreground">
              Horizon, stops, targets and costs are held fixed across the sweep, so only the
              detector is being tuned. Settings are never applied automatically — a candidate has
              to clear the holdout before it's worth shipping.
              {result.skippedSymbols.length > 0 && (
                <> Skipped for thin history: {result.skippedSymbols.join(", ")}.</>
              )}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
