import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Gauge, Wand2, Undo2, ShieldCheck } from "lucide-react";
import { getAlgoRegimeCalibration } from "@/lib/algo-regime-calibration.functions";
import { autoTuneAlgoRegime, type AutoTuneResponse } from "@/lib/algo-regime-autotune.functions";
import {
  applyAlgoRegimeTuneWithShadow,
  listAlgoRegimeTuneHistory,
  rollbackAlgoRegimeTune,
  evaluateAlgoRegimeShadow,
} from "@/lib/algo-regime-scheduled-autotune.functions";
import { POLL } from "@/lib/query-keys";

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

const STATUS_COLORS: Record<string, string> = {
  pending: "text-amber-500",
  accepted: "text-emerald-500",
  rolled_back: "text-red-500",
  superseded: "text-muted-foreground",
};

export function AlgoRegimeCalibrationCard({ portfolioId }: { portfolioId: string }) {
  const fetchCal = useServerFn(getAlgoRegimeCalibration);
  const tuneFn = useServerFn(autoTuneAlgoRegime);
  const applyShadowFn = useServerFn(applyAlgoRegimeTuneWithShadow);
  const evalShadowFn = useServerFn(evaluateAlgoRegimeShadow);
  const rollbackFn = useServerFn(rollbackAlgoRegimeTune);
  const listHistoryFn = useServerFn(listAlgoRegimeTuneHistory);
  const qc = useQueryClient();
  const [lastTune, setLastTune] = useState<AutoTuneResponse | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["algo-regime-calibration", portfolioId],
    queryFn: () => fetchCal({ data: { portfolioId, limit: 200 } }),
    refetchInterval: POLL.SLOW,
  });

  const history = useQuery({
    queryKey: ["algo-regime-tune-history", portfolioId],
    queryFn: () => listHistoryFn({ data: { portfolioId, limit: 20 } }),
    refetchInterval: POLL.SLOW,
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["algo-regime-calibration", portfolioId] });
    qc.invalidateQueries({ queryKey: ["algo-regime-tune-history", portfolioId] });
  };

  const tune = useMutation({
    mutationFn: (dryRun: boolean) => tuneFn({ data: { portfolioId, dryRun } }),
    onSuccess: (r) => {
      setLastTune(r);
      if (r.persisted) invalidateAll();
    },
  });

  const applyShadow = useMutation({
    mutationFn: () => applyShadowFn({ data: { portfolioId, dryRun: false } }),
    onSuccess: () => invalidateAll(),
  });

  const evalShadow = useMutation({
    mutationFn: () => evalShadowFn({ data: { portfolioId, windowDays: 7 } }),
    onSuccess: () => invalidateAll(),
  });

  const rollback = useMutation({
    mutationFn: (historyId: string) => rollbackFn({ data: { portfolioId, historyId } }),
    onSuccess: () => invalidateAll(),
  });


  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gauge className="h-4 w-4" /> Algo-regime calibration
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Realised next-snapshot returns bucketed by the tier active at each decision.
              Monotone means <span className="font-mono">normal ≥ elevated ≥ extreme</span> — the guard is predictive.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={tune.isPending}
              onClick={() => tune.mutate(true)}
            >
              <Wand2 className="mr-1 h-3 w-3" /> Preview tune
            </Button>
            <Button
              size="sm"
              disabled={tune.isPending}
              onClick={() => tune.mutate(false)}
            >
              Apply auto-tune
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={applyShadow.isPending}
              onClick={() => applyShadow.mutate()}
              title="Apply and start a 7-day shadow window that may auto-rollback"
            >
              <ShieldCheck className="mr-1 h-3 w-3" />
              {applyShadow.isPending ? "Applying…" : "Apply (shadow)"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={evalShadow.isPending}
              onClick={() => evalShadow.mutate()}
              title="Evaluate pending tunes past the shadow window"
            >
              {evalShadow.isPending ? "Evaluating…" : "Evaluate now"}
            </Button>

          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {data && (
          <>
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>Matched: <span className="font-mono">{data.matched}</span></span>
              <span>Unmatched: <span className="font-mono">{data.unmatched}</span></span>
              <span>
                Ladder:{" "}
                <span className={`font-semibold ${data.monotone ? "text-emerald-500" : "text-amber-500"}`}>
                  {data.monotone ? "monotone" : "not monotone"}
                </span>
              </span>
            </div>
            <div className="overflow-x-auto rounded border">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left">Tier</th>
                    <th className="px-2 py-1 text-right">N</th>
                    <th className="px-2 py-1 text-right">Mean fwd</th>
                    <th className="px-2 py-1 text-right">Std</th>
                    <th className="px-2 py-1 text-right">Hit rate</th>
                    <th className="px-2 py-1 text-right">Worst</th>
                  </tr>
                </thead>
                <tbody>
                  {data.perTier.map((t) => (
                    <tr key={t.tier} className="border-t">
                      <td className="px-2 py-1 uppercase">{t.tier}</td>
                      <td className="px-2 py-1 text-right font-mono">{t.count}</td>
                      <td className={`px-2 py-1 text-right font-mono ${t.meanReturn < 0 ? "text-red-500" : "text-emerald-500"}`}>
                        {t.count ? pct(t.meanReturn) : "—"}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {t.count ? pct(t.stdReturn) : "—"}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {t.count ? pct(t.hitRate) : "—"}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-red-500">
                        {t.count ? pct(t.worstReturn) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {tune.error && (
          <p className="text-sm text-destructive">{(tune.error as Error).message}</p>
        )}
        {lastTune && (
          <div className="rounded-lg border p-3 text-xs space-y-1 bg-muted/20">
            <div className="font-medium">
              Auto-tune {lastTune.persisted ? "applied" : lastTune.changed ? "preview" : "no-op"}
              <span className="ml-2 text-muted-foreground">({lastTune.matched} samples)</span>
            </div>
            {lastTune.notes.map((n, i) => (
              <div key={i} className="text-muted-foreground">• {n}</div>
            ))}
            {lastTune.changed && (
              <div className="mt-1 font-mono text-[11px]">
                volBurstRatio {lastTune.previous.volBurstRatio.toFixed(2)} → {lastTune.suggested.volBurstRatio.toFixed(2)},{" "}
                liquidityVacuumRatio {lastTune.previous.liquidityVacuumRatio.toFixed(2)} → {lastTune.suggested.liquidityVacuumRatio.toFixed(2)}
              </div>
            )}
          </div>
        )}
        {history.data && history.data.length > 0 && (
          <div className="rounded-lg border p-3 text-xs space-y-2 bg-muted/10">
            <div className="font-medium">Tune history</div>
            <div className="space-y-1">
              {history.data.map((row) => {
                const color = STATUS_COLORS[row.status] ?? "";
                return (
                  <div
                    key={row.id}
                    className="flex items-start justify-between gap-2 border-t pt-1 first:border-t-0 first:pt-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono">
                          {new Date(row.appliedAt).toLocaleString()}
                        </span>
                        <span className={`uppercase font-semibold ${color}`}>
                          {row.status.replace("_", " ")}
                        </span>
                      </div>
                      {row.decisionReason && (
                        <div className="text-muted-foreground">{row.decisionReason}</div>
                      )}
                      {row.notes && (
                        <div className="text-muted-foreground truncate" title={row.notes}>
                          {row.notes}
                        </div>
                      )}
                      <div className="text-[11px] text-muted-foreground">
                        baseline n={row.baseline.matched} · post n={row.post.matched ?? "—"}
                      </div>
                    </div>
                    {row.status !== "rolled_back" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={rollback.isPending}
                        onClick={() => rollback.mutate(row.id)}
                        className="shrink-0"
                      >
                        <Undo2 className="mr-1 h-3 w-3" /> Roll back
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );

}
