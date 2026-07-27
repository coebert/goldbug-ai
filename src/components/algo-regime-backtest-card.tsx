import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FlaskConical, ShieldCheck, ShieldAlert, Play } from "lucide-react";
import {
  backtestAlgoRegimeCandidate,
  type AlgoRegimeBacktestResponse,
} from "@/lib/algo-regime-backtest.functions";
import {
  applyAlgoRegimeTuneWithShadow,
} from "@/lib/algo-regime-scheduled-autotune.functions";
import type { AlgoRegimeTier } from "@/lib/microstructure/algo-regime";

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const signed = (v: number) =>
  `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

const TIER_LABEL: Record<AlgoRegimeTier, string> = {
  normal: "Normal",
  elevated: "Elevated",
  extreme: "Extreme",
};

const TIER_TONE: Record<AlgoRegimeTier, string> = {
  normal: "text-emerald-500",
  elevated: "text-amber-500",
  extreme: "text-red-500",
};

function toneForReturn(v: number, invert = false) {
  const positive = invert ? v <= 0 : v >= 0;
  return positive ? "text-emerald-500" : "text-red-500";
}

export function AlgoRegimeBacktestCard({ portfolioId }: { portfolioId: string }) {
  const backtestFn = useServerFn(backtestAlgoRegimeCandidate);
  const applyShadowFn = useServerFn(applyAlgoRegimeTuneWithShadow);
  const [result, setResult] = useState<AlgoRegimeBacktestResponse | null>(null);

  const run = useMutation({
    mutationFn: () =>
      backtestFn({
        data: { portfolioId, lookbackDays: 60, maxObservations: 120 },
      }),
    onSuccess: (r) => setResult(r),
  });

  const applyShadow = useMutation({
    mutationFn: () => applyShadowFn({ data: { portfolioId, dryRun: false } }),
  });

  const rows = useMemo(() => {
    if (!result) return [];
    return result.baseline.perTier.map((b) => {
      const c = result.candidate.perTier.find((x) => x.tier === b.tier)!;
      const delta = result.deltas.find((d) => d.tier === b.tier)!;
      return { tier: b.tier, baseline: b, candidate: c, delta };
    });
  }, [result]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <FlaskConical className="h-4 w-4" /> Algo-regime backtest
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Simulates the candidate <span className="font-mono">algo_regime</span> config
              against your historical run dates, reclassifying every day and computing
              forward returns + drawdown per tier so you can vet a change before it goes
              into shadow evaluation.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Button
              size="sm"
              disabled={run.isPending}
              onClick={() => run.mutate()}
            >
              <Play className="mr-1 h-3 w-3" />
              {run.isPending ? "Simulating…" : "Run backtest"}
            </Button>
            {result?.candidateChanged && (
              <Button
                size="sm"
                variant={result.safeToSchedule ? "secondary" : "outline"}
                disabled={applyShadow.isPending}
                onClick={() => applyShadow.mutate()}
                title={
                  result.safeToSchedule
                    ? "Schedule this candidate for a 7-day shadow evaluation"
                    : "Candidate flagged as risky — schedule anyway if you accept the tradeoff"
                }
              >
                <ShieldCheck className="mr-1 h-3 w-3" />
                {applyShadow.isPending ? "Scheduling…" : "Schedule shadow"}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {run.error && (
          <p className="text-sm text-destructive">{(run.error as Error).message}</p>
        )}
        {!result && !run.isPending && (
          <p className="text-sm text-muted-foreground">
            Click <span className="font-medium">Run backtest</span> to replay the last
            up-to-120 decision dates against the auto-tuner's candidate and compare it
            with your current live config.
          </p>
        )}

        {result && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline" className="font-mono">
                bench {result.benchSymbol}
              </Badge>
              <Badge variant="outline" className="font-mono">
                {result.observationDates.length} days
              </Badge>
              <Badge variant="outline" className="font-mono">
                cross-section {result.crossSectionSymbols.length}
              </Badge>
              <Badge variant="outline" className="font-mono">
                lookback {result.lookbackDays}d
              </Badge>
              {result.candidateChanged ? (
                <Badge
                  variant={result.safeToSchedule ? "default" : "destructive"}
                  className="gap-1"
                >
                  {result.safeToSchedule ? (
                    <ShieldCheck className="h-3 w-3" />
                  ) : (
                    <ShieldAlert className="h-3 w-3" />
                  )}
                  {result.safeToSchedule ? "safe to schedule" : "review before scheduling"}
                </Badge>
              ) : (
                <Badge variant="secondary">no candidate change</Badge>
              )}
            </div>

            <div className="text-xs text-muted-foreground">{result.reason}</div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded border p-2">
                <div className="text-muted-foreground">Baseline blocked days</div>
                <div className="font-mono">
                  {pct(result.baseline.blockedDayShare)}
                </div>
              </div>
              <div className="rounded border p-2">
                <div className="text-muted-foreground">Candidate blocked days</div>
                <div className="font-mono">
                  {pct(result.candidate.blockedDayShare)}
                </div>
              </div>
            </div>

            <div className="overflow-x-auto rounded border">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left">Tier</th>
                    <th className="px-2 py-1 text-right">N (base → cand)</th>
                    <th className="px-2 py-1 text-right">Mean fwd (base)</th>
                    <th className="px-2 py-1 text-right">Mean fwd (cand)</th>
                    <th className="px-2 py-1 text-right">Δ mean</th>
                    <th className="px-2 py-1 text-right">Max DD (base)</th>
                    <th className="px-2 py-1 text-right">Max DD (cand)</th>
                    <th className="px-2 py-1 text-right">Δ DD</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ tier, baseline, candidate, delta }) => (
                    <tr key={tier} className="border-t">
                      <td className={`px-2 py-1 uppercase font-semibold ${TIER_TONE[tier]}`}>
                        {TIER_LABEL[tier]}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {baseline.count} → {candidate.count}
                        {delta.countDelta !== 0 && (
                          <span className="ml-1 text-muted-foreground">
                            ({delta.countDelta > 0 ? "+" : ""}
                            {delta.countDelta})
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {baseline.count ? pct(baseline.meanReturn) : "—"}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {candidate.count ? pct(candidate.meanReturn) : "—"}
                      </td>
                      <td
                        className={`px-2 py-1 text-right font-mono ${toneForReturn(
                          delta.meanReturnDelta,
                          tier === "extreme",
                        )}`}
                      >
                        {signed(delta.meanReturnDelta)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-red-500">
                        {pct(baseline.maxDrawdown)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-red-500">
                        {pct(candidate.maxDrawdown)}
                      </td>
                      <td
                        className={`px-2 py-1 text-right font-mono ${toneForReturn(
                          delta.maxDrawdownDelta,
                        )}`}
                      >
                        {signed(delta.maxDrawdownDelta)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded border bg-muted/10 p-2 text-[11px] font-mono space-y-0.5">
              <div>
                volBurstRatio{" "}
                {result.activeConfig.volBurstRatio.toFixed(2)} →{" "}
                {result.candidateConfig.volBurstRatio.toFixed(2)}
              </div>
              <div>
                liquidityVacuumRatio{" "}
                {result.activeConfig.liquidityVacuumRatio.toFixed(2)} →{" "}
                {result.candidateConfig.liquidityVacuumRatio.toFixed(2)}
              </div>
              <div>
                whipsawFlipsThreshold{" "}
                {result.activeConfig.whipsawFlipsThreshold} →{" "}
                {result.candidateConfig.whipsawFlipsThreshold}
              </div>
              <div>
                correlationSpikeThreshold{" "}
                {result.activeConfig.correlationSpikeThreshold.toFixed(2)} →{" "}
                {result.candidateConfig.correlationSpikeThreshold.toFixed(2)}
              </div>
            </div>

            {result.tuneNotes.length > 0 && (
              <div className="text-[11px] text-muted-foreground space-y-0.5">
                {result.tuneNotes.map((n, i) => (
                  <div key={i}>• {n}</div>
                ))}
              </div>
            )}

            {applyShadow.error && (
              <p className="text-xs text-destructive">
                {(applyShadow.error as Error).message}
              </p>
            )}
            {applyShadow.data && (
              <p className="text-xs text-emerald-500">
                Scheduled shadow evaluation
                {applyShadow.data.historyId
                  ? ` (history id ${applyShadow.data.historyId.slice(0, 8)}…)`
                  : ""}.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
