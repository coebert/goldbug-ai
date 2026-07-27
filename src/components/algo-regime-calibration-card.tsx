import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Gauge, Wand2 } from "lucide-react";
import { getAlgoRegimeCalibration } from "@/lib/algo-regime-calibration.functions";
import { autoTuneAlgoRegime, type AutoTuneResponse } from "@/lib/algo-regime-autotune.functions";

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

export function AlgoRegimeCalibrationCard({ portfolioId }: { portfolioId: string }) {
  const fetchCal = useServerFn(getAlgoRegimeCalibration);
  const tuneFn = useServerFn(autoTuneAlgoRegime);
  const qc = useQueryClient();
  const [lastTune, setLastTune] = useState<AutoTuneResponse | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["algo-regime-calibration", portfolioId],
    queryFn: () => fetchCal({ data: { portfolioId, limit: 200 } }),
    refetchInterval: 5 * 60_000,
  });

  const tune = useMutation({
    mutationFn: (dryRun: boolean) => tuneFn({ data: { portfolioId, dryRun } }),
    onSuccess: (r) => {
      setLastTune(r);
      if (r.persisted) qc.invalidateQueries({ queryKey: ["algo-regime-calibration", portfolioId] });
    },
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
      </CardContent>
    </Card>
  );
}
